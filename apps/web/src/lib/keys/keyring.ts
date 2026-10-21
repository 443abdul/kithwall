'use client';
// Keyring: audience keys this user holds (spec §3.7). Loads sealed keys addressed to us,
// delivers our keys to friends/members who lack them, and rotates epochs on removal.
//
// Security review K1: a key is adopted only when ./authority.ts judgeKey() accepts it, i.e. it matches
// the signed epoch record of a key authority (owner / admin), or (for epochs without a record) it was
// sealed by a key authority. Keys that contradict a record are rejected, discarded on the server so the
// authority's own delivery can take their place, and reported through conflicts() / useKeyConflicts().
// Minting a key always publishes its signed record (record_audience_epoch / advance_audience_epoch).
//
// Security review K2: keys are only sealed to people whose identity keys this device has pinned, or
// whose change the user accepted (./pins.ts sealGate).
//
// Security review R-K-1: seals and epoch records are verified against the identity keys this device TRUSTS
// (people.get(id).sign_pub once ./pins.ts resolveSigners is installed: the pinned key, or one a signed key
// change vouches for), never a key the server merely publishes. A key that only verifies against an
// unconfirmed new identity key is not adopted; it waits (retried after the user accepts the change) and is
// reported as an 'identity' warning for its audience (useKeyConflicts).
//
// Security review R-K-2: admins count as key authorities only with a chain of signed grants back to the
// owner (./authority.ts verifiedAdmins); unsigned (server-made) admins can't get a key adopted.
import {
  b64u, epochCommit, newSymmetricKey, openSealed, seal, signAdminGrant, signEpochRecord, type Identity, type Sealed, type Unlocked,
} from '@kithwall/crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { sb, must } from '../supabase';
import type { AudienceRow } from '../types';
import { people } from '../people';
import {
  judgeIncoming, isKeyAuthority, recordIsValid, verifiedAdmins,
  type AudienceMeta, type EpochRecordRow, type GrantRow, type Roster, type TrustedSigner,
} from './authority';
import { onPinsChanged, resolveSigners, sealGate } from './pins';

const ctx = (aud: string, epoch: number, recipient: string) => `audience-key/${aud}/${epoch}/${recipient}`;
const k = (aud: string, epoch: number) => `${aud}:${epoch}`;

/**
 * conflict: a key contradicted its audience's signed record (someone tried to hand out a key of their own).
 * identity: a key or record was signed by an identity key this device doesn't trust yet (sealedBy is that
 * person): their safety number changed and the change wasn't signed with their old key.
 */
export interface KeyConflict { audienceId: string; epoch: number; sealedBy: string; at: string; reason: 'conflict' | 'identity' }

const EMPTY_ROSTER: Roster = { admins: new Set(), members: new Set() };

class Keyring {
  private keys = new Map<string, Uint8Array>();
  private userId: string | null = null;
  private u: Unlocked | null = null;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Rows we could not judge yet (no record / authority delivery so far); retried on every load. */
  private waiting = new Map<string, KeyRow>();
  private conflictList: KeyConflict[] = [];
  private conflictListeners = new Set<() => void>();
  friendsAudience: AudienceRow | null = null;
  selfAudience: AudienceRow | null = null;
  version = 0;
  /** True once start() has loaded our keys and default audiences (writers need them; see whenReady). */
  ready = false;
  private readyWaiters = new Set<() => void>();
  private readyListeners = new Set<() => void>();
  private unpin: (() => void) | null = null;

  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private bump() { this.version++; people.invalidateInfos(); this.listeners.forEach((l) => l()); }

  /**
   * Resolves once the keyring is ready. The session turns 'ready' a moment before start() has loaded the
   * keys (and stop() + start() run again on every unlock), so anything that encrypts right after sign-in
   * waits here instead of failing on a missing audience. Rejects after `timeoutMs`.
   */
  whenReady(timeoutMs = 20_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.readyWaiters.delete(done); resolve(); };
      const timer = setTimeout(() => { this.readyWaiters.delete(done); reject(new Error('Keys are not ready yet')); }, timeoutMs);
      this.readyWaiters.add(done);
    });
  }

  /** Notified when `ready` changes (separate from subscribe(), which also invalidates every query). */
  subscribeReady(l: () => void) { this.readyListeners.add(l); return () => { this.readyListeners.delete(l); }; }

  private setReady(v: boolean) {
    this.ready = v;
    if (v) [...this.readyWaiters].forEach((w) => w());
    this.readyListeners.forEach((l) => l());
  }

  /** Keys that contradicted their audience's signed record (possible tampering), newest last. */
  conflicts(): readonly KeyConflict[] { return this.conflictList; }
  subscribeConflicts(l: () => void) { this.conflictListeners.add(l); return () => { this.conflictListeners.delete(l); }; }

  async start(userId: string, u: Unlocked) {
    this.userId = userId; this.u = u; this.keys.clear(); this.waiting.clear();
    people.setKeyLookup((aud, epoch) => this.get(aud, epoch));
    // R-K-1: from now on people.get() carries the keys this device trusts (pins), not the published ones.
    await people.setTrustResolver(resolveSigners);
    this.unpin?.();
    this.unpin = onPinsChanged((ids) => {
      // An identity change was accepted: re-check that person's items and retry what waited on them.
      people.forget(ids);
      this.conflictList = this.conflictList.filter((c) => !(c.reason === 'identity' && ids.includes(c.sealedBy)));
      this.conflictListeners.forEach((l) => l());
      if (this.waiting.size) void this.ingest([...this.waiting.values()]).then(() => this.bump());
    });
    await this.loadMyAudiences();
    await this.load();
    await this.ensureOwn(this.friendsAudience!);
    await this.ensureOwn(this.selfAudience!);
    this.setReady(true);
    await this.deliverPending().catch((e) => console.warn('key delivery', e));
    this.channel = sb().channel(`keys:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audience_keys', filter: `recipient_id=eq.${userId}` },
        (p) => { void this.ingest([p.new as KeyRow]).then(() => this.bump()); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
        () => { void this.deliverPending().catch(() => undefined); })
      .subscribe();
    // Safety net: deliver keys (and retry keys we couldn't judge yet) periodically while the app is open.
    this.timer = setInterval(() => {
      void this.deliverPending().catch(() => undefined);
      if (this.waiting.size) void this.ingest([...this.waiting.values()]).then((n) => { if (n) this.bump(); });
    }, 60_000);
    this.bump();
  }

  async stop() {
    if (this.ready) this.setReady(false);
    if (this.channel) await sb().removeChannel(this.channel);
    if (this.timer) clearInterval(this.timer);
    this.unpin?.(); this.unpin = null;
    void people.setTrustResolver(null);
    this.channel = null; this.timer = null; this.keys.clear(); this.waiting.clear(); this.u = null; this.userId = null;
    this.friendsAudience = null; this.selfAudience = null;
    if (this.conflictList.length) { this.conflictList = []; this.conflictListeners.forEach((l) => l()); }
  }

  private async loadMyAudiences() {
    const rows = must(await sb().from('audiences').select('*').eq('owner_id', this.userId!).in('kind', ['friends', 'self'])) as AudienceRow[];
    this.friendsAudience = rows.find((r) => r.kind === 'friends') ?? null;
    this.selfAudience = rows.find((r) => r.kind === 'self') ?? null;
    if (!this.friendsAudience || !this.selfAudience) throw new Error('Default audiences missing');
  }

  /** Load every sealed key addressed to us (paged). */
  async load() {
    const rows: KeyRow[] = [];
    for (let from = 0; ; from += 1000) {
      const page = must(await sb().from('audience_keys').select('*').eq('recipient_id', this.userId!).range(from, from + 999)) as KeyRow[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    await this.ingest(rows);
  }

  /** Audience rows, active rosters and epoch records for these audiences (whatever RLS lets us see). */
  private async context(audIds: string[]): Promise<{ auds: Map<string, AudienceMeta>; rosters: Map<string, Roster>; records: Map<string, EpochRecordRow> }> {
    const auds = new Map<string, AudienceMeta>();
    const rosters = new Map<string, Roster>();
    const records = new Map<string, EpochRecordRow>();
    const grants = new Map<string, GrantRow[]>();
    for (let i = 0; i < audIds.length; i += 100) {
      const chunk = audIds.slice(i, i + 100);
      const [a, m, r] = await Promise.all([
        sb().from('audiences').select('id, kind, owner_id, current_epoch').in('id', chunk),
        sb().from('audience_members').select('audience_id, member_id, role, grant_by, grant_sig').in('audience_id', chunk).eq('status', 'active'),
        sb().from('audience_epochs').select('audience_id, epoch, rotated_by, commit, sig').in('audience_id', chunk),
      ]);
      for (const row of (a.data ?? []) as AudienceMeta[]) auds.set(row.id, row);
      for (const row of (m.data ?? []) as ({ audience_id: string } & GrantRow)[]) {
        const g = grants.get(row.audience_id) ?? [];
        g.push(row);
        grants.set(row.audience_id, g);
      }
      // A missing table (database without this migration) simply means "no records".
      for (const row of (r.data ?? []) as EpochRecordRow[]) records.set(k(row.audience_id, row.epoch), row);
    }
    // Admin grants are verified against trusted keys (R-K-1 + R-K-2): load the granters first.
    await people.ensure([...grants.values()].flatMap((g) => g.map((x) => x.grant_by ?? '')).filter(Boolean));
    for (const [audId, g] of grants) {
      const a = auds.get(audId);
      const admins = a ? verifiedAdmins(a, g, (id) => this.signerOf(id)?.s) : new Set<string>();
      rosters.set(audId, { admins, members: new Set(g.map((x) => x.member_id)) });
    }
    return { auds, rosters, records };
  }

  /** The identity key this device trusts for someone (my own: from my unlocked identity). */
  private signerOf(id: string): TrustedSigner | null {
    if (id === this.userId && this.u) return { s: b64u.encode(this.u.identity.signPub), trust: 'self' };
    const p = people.get(id);
    if (!p) return null;
    return { s: p.sign_pub, trust: people.trust(id) ?? 'new' };
  }

  /** Verify, judge and adopt sealed keys. Returns how many keys were adopted. */
  private async ingest(rows: KeyRow[]): Promise<number> {
    if (!this.u || !rows.length) return 0;
    const todo = rows.filter((r) => !this.keys.has(k(r.audience_id, r.epoch)));
    if (!todo.length) return 0;
    const { auds, rosters, records } = await this.context([...new Set(todo.map((r) => r.audience_id))]);
    await people.ensure([...todo.map((r) => r.sealed_by), ...[...records.values()].map((r) => r.rotated_by)]);
    let adopted = 0;
    const refreshed = new Set<string>();
    for (const r of todo) {
      const id = k(r.audience_id, r.epoch);
      if (this.keys.has(id)) continue;
      const judge = () => judgeIncoming({
        aud: auds.get(r.audience_id) ?? null, roster: rosters.get(r.audience_id) ?? EMPTY_ROSTER, epoch: r.epoch,
        sealedBy: r.sealed_by, record: records.get(id) ?? null, signer: (who) => this.signerOf(who), open: (pub) => this.open(r, pub),
      });
      let res = judge();
      if (!res.ok && (res.reason === 'unverified' || res.identity) && r.sealed_by !== this.userId && !refreshed.has(r.sealed_by)) {
        // The sealer may have rotated their identity key with a signed change (re-signing their deliveries)
        // since we cached them: re-read and re-resolve them once. A vouched change is then trusted; an
        // unvouched one still isn't.
        refreshed.add(r.sealed_by);
        people.forget([r.sealed_by]);
        await people.ensure([r.sealed_by]);
        res = judge();
      }
      if (res.ok) { this.keys.set(id, res.key); this.waiting.delete(id); adopted++; continue; }
      if (res.identity) this.flagConflict(r, 'identity', res.identity);
      if (res.reason === 'unverified') { console.warn('Rejected an audience key that failed verification', r.audience_id, r.epoch); continue; }
      if (res.reason === 'wait') { this.waiting.set(id, r); continue; }
      // Conflict: never adopted. Discard our copy so the authority's delivery can replace it.
      this.waiting.delete(id);
      this.flagConflict(r, 'conflict', r.sealed_by);
      void sb().from('audience_keys').delete()
        .match({ audience_id: r.audience_id, epoch: r.epoch, recipient_id: this.userId!, sealed_by: r.sealed_by })
        .then(() => undefined, () => undefined);
    }
    return adopted;
  }

  private open(r: KeyRow, sealerSignPub: string): Uint8Array | null {
    const id = this.u!.identity;
    const tries = [{ kxPriv: id.kxPriv, kxPub: id.kxPub }, ...(this.u!.previousKx ?? [])];
    for (const t of tries) {
      try {
        return openSealed({
          sealed: r.sealed as Sealed, recipientKxPriv: t.kxPriv, recipientKxPub: t.kxPub,
          senderSignPub: b64u.decode(sealerSignPub), context: ctx(r.audience_id, r.epoch, r.recipient_id),
        });
      } catch { /* try an earlier identity */ }
    }
    return null;
  }

  private flagConflict(r: KeyRow, reason: KeyConflict['reason'], who: string) {
    if (reason === 'conflict') console.warn('SECURITY: an audience key contradicts the signed key record of its owner; it was rejected', r.audience_id, r.epoch, who);
    else console.warn('SECURITY: a key for this audience is signed by an identity key this device does not trust yet; it was not used', r.audience_id, r.epoch, who);
    if (this.conflictList.some((c) => c.audienceId === r.audience_id && c.epoch === r.epoch && c.sealedBy === who && c.reason === reason)) return;
    this.conflictList = [...this.conflictList, { audienceId: r.audience_id, epoch: r.epoch, sealedBy: who, at: new Date().toISOString(), reason }].slice(-50);
    this.conflictListeners.forEach((l) => l());
  }

  has(aud: string, epoch: number) { return this.keys.has(k(aud, epoch)); }
  get(aud: string, epoch: number): Uint8Array | null { return this.keys.get(k(aud, epoch)) ?? null; }

  /** Current key for an audience we can write to (creating it if we own the audience). */
  async current(aud: string): Promise<{ key: Uint8Array; epoch: number }> {
    await this.whenReady();
    const row = must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
    let key = this.get(aud, row.current_epoch);
    if (!key) {
      await this.load();
      key = this.get(aud, row.current_epoch);
    }
    if (!key && row.owner_id === this.userId) key = await this.ensureOwn(row);
    if (!key) throw new KeyWaitingError(aud);
    return { key, epoch: row.current_epoch };
  }

  private record(aud: string, epoch: number, key: Uint8Array) {
    const commit = epochCommit(aud, epoch, key);
    return { commit, sig: signEpochRecord(this.u!.identity.signPriv, { audienceId: aud, epoch, rotatedBy: this.userId!, commit }) };
  }

  /**
   * Make sure an audience we own has a key for its current epoch. Minting publishes the signed record
   * first; if a record already exists, someone (another of our devices, or an admin) minted it and we
   * wait for their key instead of making a second one.
   */
  async ensureOwn(row: AudienceRow): Promise<Uint8Array> {
    const existing = this.get(row.id, row.current_epoch);
    if (existing) return existing;
    const key = newSymmetricKey();
    const rec = this.record(row.id, row.current_epoch, key);
    const res = await sb().rpc('record_audience_epoch', { aud: row.id, ep: row.current_epoch, p_commit: rec.commit, p_sig: rec.sig });
    if (res.error) throw new Error(res.error.message);
    if (res.data === false) {
      await this.load();
      const theirs = this.get(row.id, row.current_epoch);
      if (theirs) return theirs;
      throw new KeyWaitingError(row.id);
    }
    await this.storeFor(row.id, row.current_epoch, this.userId!, this.u!.identity.kxPub, key, true);
    this.keys.set(k(row.id, row.current_epoch), key);
    return key;
  }

  /**
   * Seal a key to one person. `own` is our own copy: a duplicate there means someone else already put a
   * key in our slot, which must not be silently accepted (it is re-read and judged instead).
   */
  private async storeFor(aud: string, epoch: number, recipient: string, recipientKxPub: Uint8Array, key: Uint8Array, own = false) {
    const sealed = seal({ recipientKxPub, senderSignPriv: this.u!.identity.signPriv, context: ctx(aud, epoch, recipient), plaintext: key });
    const res = await sb().from('audience_keys').insert({ audience_id: aud, epoch, recipient_id: recipient, sealed_by: this.userId, sealed });
    if (!res.error) return;
    if (res.error.code === '23505') {
      if (!own) return; // someone else delivered it; the recipient judges it
      await this.load();
      const held = this.get(aud, epoch);
      if (held && b64u.encode(held) === b64u.encode(key)) return;
      throw new Error('A different key is already stored for this epoch; refusing to use it.');
    }
    throw new Error(res.error.message);
  }

  /**
   * Seal keys we hold to entitled people (used by group/event history delivery too). Recipients whose
   * identity keys changed without confirmation are skipped (sealGate). Returns how many were sealed.
   */
  async deliverTo(rows: { audience_id: string; epoch: number; recipient_id: string; recipient_kx_pub: string; recipient_sign_pub?: string }[]): Promise<number> {
    if (!this.u || !rows.length) return 0;
    const ids = [...new Set(rows.map((r) => r.recipient_id))];
    // Fresh published keys for everyone we are about to seal to.
    const profs = new Map<string, { s: string; x: string }>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb().from('profiles').select('id, sign_pub, kx_pub').in('id', ids.slice(i, i + 100));
      for (const p of (data ?? []) as { id: string; sign_pub: string; kx_pub: string }[]) profs.set(p.id, { s: p.sign_pub, x: p.kx_pub });
    }
    const allowed = await sealGate([...profs].map(([id, p]) => ({ id, ...p })));
    let n = 0;
    for (const r of rows) {
      const key = this.get(r.audience_id, r.epoch);
      const p = profs.get(r.recipient_id);
      if (!key || !p || !allowed.has(r.recipient_id)) continue;
      try {
        await this.storeFor(r.audience_id, r.epoch, r.recipient_id, b64u.decode(p.x), key);
        n++;
      } catch (e) {
        // Not entitled (any more), or the record isn't there yet for a relay: the authority delivers.
        console.warn('key delivery skipped', r.audience_id, r.epoch, (e as Error).message);
      }
    }
    return n;
  }

  /** Deliver our current keys to everyone entitled who lacks them (friends, members). */
  async deliverPending(): Promise<number> {
    if (!this.u) return 0;
    const rows = must(await sb().rpc('pending_key_deliveries')) as {
      audience_id: string; epoch: number; recipient_id: string; recipient_kx_pub: string; recipient_sign_pub: string;
    }[];
    if (!rows.length) return 0;
    await this.recordHeldEpochs(rows);
    return this.deliverTo(rows);
  }

  /**
   * Epochs that predate records: as their key authority, publish the record of the key we hold so that
   * members can relay it (and every recipient can check it).
   */
  private async recordHeldEpochs(rows: { audience_id: string; epoch: number }[]) {
    const pairs = new Map(rows.filter((r) => this.has(r.audience_id, r.epoch)).map((r) => [k(r.audience_id, r.epoch), r]));
    if (!pairs.size) return;
    const { auds, rosters, records } = await this.context([...new Set([...pairs.values()].map((r) => r.audience_id))]);
    for (const [id, r] of pairs) {
      const a = auds.get(r.audience_id);
      if (!a || a.current_epoch !== r.epoch || records.has(id) || !isKeyAuthority(a, rosters.get(a.id) ?? EMPTY_ROSTER, this.userId!)) continue;
      const rec = this.record(r.audience_id, r.epoch, this.get(r.audience_id, r.epoch)!);
      await sb().rpc('record_audience_epoch', { aud: r.audience_id, ep: r.epoch, p_commit: rec.commit, p_sig: rec.sig })
        .then(() => undefined, () => undefined);
    }
  }

  /**
   * Rotation: mint the next epoch's key, publish its signed record and advance the epoch in one step
   * (compare-and-swap on `fromEpoch`). Returns the new audience row, or null if someone else rotated
   * first (we then receive their key).
   */
  async advance(aud: string, fromEpoch: number): Promise<AudienceRow | null> {
    const next = fromEpoch + 1;
    const key = newSymmetricKey();
    const rec = this.record(aud, next, key);
    const res = await sb().rpc('advance_audience_epoch', { aud, from_epoch: fromEpoch, p_commit: rec.commit, p_sig: rec.sig });
    if (res.error) throw new Error(res.error.message);
    if (res.data === null || res.data === undefined) return null;
    this.keys.set(k(aud, next), key);
    await this.storeFor(aud, next, this.userId!, this.u!.identity.kxPub, key, true);
    return must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
  }

  /**
   * After a signed identity-key rotation (lib/keys/identity.ts): re-seal every key delivery we made and
   * re-sign every epoch record we made with the NEW identity, so recipients (who check signatures
   * against our current published key) keep accepting them. Our own copies are re-sealed to our new
   * key-exchange key. Returns how many rows were renewed.
   */
  async resealMine(next: Identity): Promise<number> {
    if (!this.userId) return 0;
    const me = this.userId;
    let n = 0;
    const rows: KeyRow[] = [];
    for (let from = 0; ; from += 1000) {
      const page = must(await sb().from('audience_keys').select('*').eq('sealed_by', me).range(from, from + 999)) as KeyRow[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const ids = [...new Set(rows.map((r) => r.recipient_id))].filter((id) => id !== me);
    const kx = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb().from('profiles').select('id, kx_pub').in('id', ids.slice(i, i + 100));
      for (const p of (data ?? []) as { id: string; kx_pub: string }[]) kx.set(p.id, p.kx_pub);
    }
    for (const r of rows) {
      const key = this.get(r.audience_id, r.epoch);
      const to = r.recipient_id === me ? next.kxPub : kx.has(r.recipient_id) ? b64u.decode(kx.get(r.recipient_id)!) : null;
      if (!key || !to) continue;
      const sealed = seal({ recipientKxPub: to, senderSignPriv: next.signPriv, context: ctx(r.audience_id, r.epoch, r.recipient_id), plaintext: key });
      const res = await sb().from('audience_keys').update({ sealed })
        .match({ audience_id: r.audience_id, epoch: r.epoch, recipient_id: r.recipient_id, sealed_by: me });
      if (!res.error) n++;
    }
    const recs = must(await sb().from('audience_epochs').select('audience_id, epoch, commit').eq('rotated_by', me)) as { audience_id: string; epoch: number; commit: string }[];
    for (const r of recs) {
      const sig = signEpochRecord(next.signPriv, { audienceId: r.audience_id, epoch: r.epoch, rotatedBy: me, commit: r.commit });
      const res = await sb().from('audience_epochs').update({ sig }).match({ audience_id: r.audience_id, epoch: r.epoch });
      if (!res.error) n++;
    }
    // R-K-2: admin grants I signed are re-signed too, or the admins I made stop counting as key authorities.
    const grants = ((await sb().from('audience_members').select('audience_id, member_id').eq('grant_by', me).eq('role', 'admin')).data ?? []) as { audience_id: string; member_id: string }[];
    for (const g of grants) {
      const grant_sig = signAdminGrant(next.signPriv, { audienceId: g.audience_id, memberId: g.member_id, grantedBy: me });
      const res = await sb().from('audience_members').update({ grant_by: me, grant_sig }).match({ audience_id: g.audience_id, member_id: g.member_id });
      if (!res.error) n++;
    }
    return n;
  }

  /**
   * Security review R-K-4 (and R-K-1): true when I am a key authority of this audience and the record of
   * its CURRENT epoch no longer counts on this device: its rotator was demoted or left, or it was signed
   * with an identity key this device doesn't trust. Members can't adopt that epoch's key, so an authority
   * should rotate (circle housekeeping and demotion do).
   */
  async currentRecordStale(aud: string): Promise<boolean> {
    if (!this.userId) return false;
    const { auds, rosters, records } = await this.context([aud]);
    const a = auds.get(aud);
    if (!a) return false;
    const rec = records.get(k(aud, a.current_epoch));
    const ro = rosters.get(aud) ?? EMPTY_ROSTER;
    if (!rec || !isKeyAuthority(a, ro, this.userId)) return false;
    await people.ensure([rec.rotated_by]);
    return !recordIsValid(a, ro, rec, this.signerOf(rec.rotated_by)?.s ?? null);
  }

  /** Sign an admin grant for `memberId` in this audience (R-K-2). */
  grantAdmin(aud: string, memberId: string): { grant_by: string; grant_sig: string } {
    if (!this.u || !this.userId) throw new Error('Locked');
    return { grant_by: this.userId, grant_sig: signAdminGrant(this.u.identity.signPriv, { audienceId: aud, memberId, grantedBy: this.userId }) };
  }

  /** Create a new epoch after removing someone; remaining members get the new key. */
  async rotate(aud: string): Promise<void> {
    const row = must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
    await this.advance(aud, row.current_epoch);
    await this.deliverPending();
    this.bump();
  }

  /** Create a new audience we own (list, group, event, conversation) with its first key. */
  async createAudience(kind: AudienceRow['kind'], nameEnc?: unknown): Promise<AudienceRow> {
    const row = must(await sb().from('audiences').insert({ owner_id: this.userId, kind, name_enc: nameEnc ?? null }).select().single()) as AudienceRow;
    await this.ensureOwn(row);
    return row;
  }
}

export interface KeyRow { audience_id: string; epoch: number; recipient_id: string; sealed_by: string; sealed: unknown; created_at: string }

/** Thrown when content exists but its author's device hasn't delivered the key yet. */
export class KeyWaitingError extends Error {
  constructor(public audienceId: string) { super('Waiting for a key from the author\'s device'); }
}

export const keyring = new Keyring();

const NO_CONFLICTS: readonly KeyConflict[] = [];
/** Rejected conflicting keys (optionally only for one audience), for security warnings in the UI. */
export function useKeyConflicts(audienceId?: string | null): readonly KeyConflict[] {
  const all = useSyncExternalStore((l) => keyring.subscribeConflicts(l), () => keyring.conflicts(), () => NO_CONFLICTS);
  if (audienceId === undefined) return all;
  return audienceId ? all.filter((c) => c.audienceId === audienceId) : NO_CONFLICTS;
}
