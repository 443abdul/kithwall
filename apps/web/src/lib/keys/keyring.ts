'use client';
// Keyring: audience keys this user holds (spec §3.7). Loads sealed keys addressed to us,
// delivers our keys to friends/members who lack them, and rotates epochs on removal.
import { b64u, newSymmetricKey, openSealed, seal, type Sealed, type Unlocked } from '@kithwall/crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { sb, must } from '../supabase';
import type { AudienceRow } from '../types';
import { people } from '../people';

const ctx = (aud: string, epoch: number, recipient: string) => `audience-key/${aud}/${epoch}/${recipient}`;
const k = (aud: string, epoch: number) => `${aud}:${epoch}`;

class Keyring {
  private keys = new Map<string, Uint8Array>();
  private userId: string | null = null;
  private u: Unlocked | null = null;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  friendsAudience: AudienceRow | null = null;
  selfAudience: AudienceRow | null = null;
  version = 0;

  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private bump() { this.version++; people.invalidateInfos(); this.listeners.forEach((l) => l()); }

  async start(userId: string, u: Unlocked) {
    this.userId = userId; this.u = u; this.keys.clear();
    people.setKeyLookup((aud, epoch) => this.get(aud, epoch));
    await this.loadMyAudiences();
    await this.load();
    await this.ensureOwn(this.friendsAudience!);
    await this.ensureOwn(this.selfAudience!);
    await this.deliverPending().catch((e) => console.warn('key delivery', e));
    this.channel = sb().channel(`keys:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audience_keys', filter: `recipient_id=eq.${userId}` },
        (p) => { void this.ingest([p.new as KeyRow]).then(() => this.bump()); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
        () => { void this.deliverPending().catch(() => undefined); })
      .subscribe();
    // Safety net: deliver keys periodically while the app is open.
    this.timer = setInterval(() => { void this.deliverPending().catch(() => undefined); }, 60_000);
    this.bump();
  }

  async stop() {
    if (this.channel) await sb().removeChannel(this.channel);
    if (this.timer) clearInterval(this.timer);
    this.channel = null; this.timer = null; this.keys.clear(); this.u = null; this.userId = null;
    this.friendsAudience = null; this.selfAudience = null;
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

  private async ingest(rows: KeyRow[]) {
    if (!this.u || !rows.length) return;
    await people.ensure(rows.map((r) => r.sealed_by));
    for (const r of rows) {
      if (this.keys.has(k(r.audience_id, r.epoch))) continue;
      const sealer = people.get(r.sealed_by);
      if (!sealer) continue;
      try {
        const key = openSealed({
          sealed: r.sealed as Sealed, recipientKxPriv: this.u.identity.kxPriv, recipientKxPub: this.u.identity.kxPub,
          senderSignPub: b64u.decode(sealer.sign_pub), context: ctx(r.audience_id, r.epoch, r.recipient_id),
        });
        this.keys.set(k(r.audience_id, r.epoch), key);
      } catch (e) {
        console.warn('Rejected an audience key that failed verification', r.audience_id, r.epoch, e);
      }
    }
  }

  has(aud: string, epoch: number) { return this.keys.has(k(aud, epoch)); }
  get(aud: string, epoch: number): Uint8Array | null { return this.keys.get(k(aud, epoch)) ?? null; }

  /** Current key for an audience we can write to (creating it if we own the audience). */
  async current(aud: string): Promise<{ key: Uint8Array; epoch: number }> {
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

  /** Make sure an audience we own has a key for its current epoch (self-sealed copy stored). */
  async ensureOwn(row: AudienceRow): Promise<Uint8Array> {
    const existing = this.get(row.id, row.current_epoch);
    if (existing) return existing;
    const key = newSymmetricKey();
    await this.storeFor(row.id, row.current_epoch, this.userId!, this.u!.identity.kxPub, key);
    this.keys.set(k(row.id, row.current_epoch), key);
    return key;
  }

  private async storeFor(aud: string, epoch: number, recipient: string, recipientKxPub: Uint8Array, key: Uint8Array) {
    const sealed = seal({ recipientKxPub, senderSignPriv: this.u!.identity.signPriv, context: ctx(aud, epoch, recipient), plaintext: key });
    const res = await sb().from('audience_keys').insert({ audience_id: aud, epoch, recipient_id: recipient, sealed_by: this.userId, sealed });
    if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
  }

  /** Deliver our current keys to everyone entitled who lacks them (friends, members). */
  async deliverPending(): Promise<number> {
    if (!this.u) return 0;
    const rows = must(await sb().rpc('pending_key_deliveries')) as {
      audience_id: string; epoch: number; recipient_id: string; recipient_kx_pub: string; recipient_sign_pub: string;
    }[];
    let n = 0;
    for (const r of rows) {
      const key = this.get(r.audience_id, r.epoch);
      if (!key) continue; // we don't hold it (e.g. admin of a group whose key we haven't received)
      await this.storeFor(r.audience_id, r.epoch, r.recipient_id, b64u.decode(r.recipient_kx_pub), key);
      n++;
    }
    return n;
  }

  /** Create a new epoch after removing someone; remaining members get the new key. */
  async rotate(aud: string): Promise<void> {
    const row = must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
    const next = must(await sb().from('audiences').update({ current_epoch: row.current_epoch + 1 }).eq('id', aud).select().single()) as AudienceRow;
    await this.ensureOwn(next);
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
