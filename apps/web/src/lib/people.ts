'use client';
// People directory: public routing data (username, public keys) plus each person's
// encrypted profile info, decrypted when we hold the key for their friends audience.
//
// Security review R-K-1: once the session is unlocked, the keyring installs a trust resolver
// (lib/keys/pins.ts resolveSigners). Every row is then stored with the identity keys THIS DEVICE trusts for
// that person: the pinned keys, or published keys that a signed key change from the pinned ones vouches for.
// If the server publishes a different key that nothing vouches for, rows keep the pinned key, so every
// signature check that goes through people.get(id).sign_pub (keys, epoch records, posts, messages, profile
// info, notifications) fails for things signed by the new key, and sealing keeps using the pinned kx key.
// The published keys stay available through published(id) for the safety-number screens.
import { b64u, openEnvelope, type Envelope } from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { sb, must } from './supabase';
import { coalescer, droppedPaths, staleInfos, type InfoStamp } from './peopleSync';
import { openExtra } from './social/profileTiers';
import type { ProfileInfo, ProfileRow } from './types';
import { knownOffline } from './net/offline';

export interface ProfileInfoRow extends InfoStamp { envelope: Envelope }

export interface Person extends ProfileRow {
  info: ProfileInfo | null;      // decrypted profile info if we can read it
  name: string;                  // best available display name
}

type KeyLookup = (aud: string, epoch: number) => Uint8Array | null;
export interface PeopleSnapshot { rows: { row: ProfileRow; trust: SignerTrust | null }[]; infos: ProfileInfoRow[] }
const MAX_SNAPSHOT = 3000;
export type SignerTrust = 'self' | 'new' | 'pinned' | 'vouched' | 'unvouched';
export type TrustResolver = (rows: { id: string; s: string; x: string }[]) => Promise<Map<string, { s: string; x: string; trust: SignerTrust }>>;

class People {
  private rows = new Map<string, ProfileRow>();
  private infos = new Map<string, ProfileInfo | null>();
  private infoRows = new Map<string, ProfileInfoRow>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private keyLookup: KeyLookup = () => null;
  private resolver: TrustResolver | null = null;
  private publishedKeys = new Map<string, { s: string; x: string }>();
  private trustOf = new Map<string, SignerTrust>();
  /** Storage paths of the avatar last decrypted for each person (to free them when it changes). */
  private avatarPaths = new Map<string, string[]>();
  private releaseFiles: (paths: string[]) => void = () => undefined;
  private syncer = coalescer(() => this.syncInfos(), 250);
  version = 0;

  /** Called with storage paths a profile stopped using (lib/media releaseFileUrls), so old pictures are freed. */
  setFileRelease(fn: (paths: string[]) => void) { this.releaseFiles = fn; }

  setKeyLookup(fn: KeyLookup) { this.keyLookup = fn; }

  /**
   * Install (or remove) the pin-based trust resolver. Rows cached before are re-resolved now, so nothing
   * keeps a server-published key this device doesn't trust.
   */
  async setTrustResolver(fn: TrustResolver | null): Promise<void> {
    this.resolver = fn;
    const cached = [...this.rows.values()].map((r) => {
      const pub = this.publishedKeys.get(r.id);
      return pub ? { ...r, sign_pub: pub.s, kx_pub: pub.x } : r;
    });
    this.rows.clear(); this.infos.clear(); this.trustOf.clear();
    if (cached.length) await this.adopt(cached).catch((e) => console.warn('people: could not check keys', e));
    this.bump();
  }

  /** Store rows with the keys this device trusts (see the header). Without a resolver: as published. */
  private async adopt(rows: ProfileRow[]): Promise<void> {
    for (const r of rows) this.publishedKeys.set(r.id, { s: r.sign_pub, x: r.kx_pub });
    if (!this.resolver) {
      for (const r of rows) { this.rows.set(r.id, r); this.trustOf.delete(r.id); }
      return;
    }
    const trusted = await this.resolver(rows.map((r) => ({ id: r.id, s: r.sign_pub, x: r.kx_pub })));
    for (const r of rows) {
      const t = trusted.get(r.id);
      if (!t) continue;
      this.rows.set(r.id, { ...r, sign_pub: t.s, kx_pub: t.x });
      this.trustOf.set(r.id, t.trust);
      this.infos.delete(r.id);
    }
  }

  /** How this device trusts the keys it holds for this person (null: not loaded, or no resolver yet). */
  trust(id: string): SignerTrust | null { return this.trustOf.get(id) ?? null; }
  /** The server-published identity keys (may differ from the trusted ones in get()). */
  published(id: string): { s: string; x: string } | null { return this.publishedKeys.get(id) ?? null; }
  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private bump() { this.version++; this.listeners.forEach((l) => l()); }

  get(id: string): ProfileRow | undefined { return this.rows.get(id); }
  /** The sealed profile_info row cached for this person (undefined: none read yet). */
  infoRow(id: string): ProfileInfoRow | undefined { return this.infoRows.get(id); }

  /** Drop cached rows (e.g. after an identity-key change) so the next ensure() reads them fresh. */
  forget(ids: Iterable<string>) { for (const id of ids) { this.rows.delete(id); this.infos.delete(id); this.trustOf.delete(id); } this.bump(); }

  person(id: string): Person | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const info = this.decryptInfo(id);
    return { ...row, info, name: info?.name || row.display_name_public || row.username };
  }

  /**
   * For the offline snapshot (lib/keys/offline): the rows as this device trusts them (identity keys already
   * resolved through the pins) and their sealed profile info.
   */
  snapshot(): PeopleSnapshot {
    const rows = [...this.rows.values()].slice(0, MAX_SNAPSHOT);
    return {
      rows: rows.map((r) => ({ row: r, trust: this.trustOf.get(r.id) ?? null })),
      infos: rows.map((r) => this.infoRows.get(r.id)).filter((x): x is ProfileInfoRow => !!x),
    };
  }

  /**
   * Opened without a connection: take the rows trusted the last time this device was online. They bypass
   * the resolver on purpose (it needs the vault, i.e. the server); the keys in them are the resolved ones.
   */
  restore(snap: PeopleSnapshot) {
    for (const { row, trust } of snap.rows) {
      if (!row?.id || typeof row.sign_pub !== 'string') continue;
      this.rows.set(row.id, row);
      if (trust) this.trustOf.set(row.id, trust); else this.trustOf.delete(row.id);
      this.infos.delete(row.id);
    }
    for (const r of snap.infos) if (r?.user_id && this.rows.has(r.user_id)) this.infoRows.set(r.user_id, r);
    this.bump();
  }

  /** Fetch any missing profile rows (and their encrypted info) in batches. */
  async ensure(ids: Iterable<string>): Promise<void> {
    // Opened offline: don't wait on requests that can't succeed; people not on this device stay "loading".
    if (knownOffline()) return;
    const missing = [...new Set(ids)].filter((id) => id && !this.rows.has(id) && !this.inflight.has(id));
    const waits = [...new Set(ids)].map((id) => this.inflight.get(id)).filter(Boolean) as Promise<void>[];
    if (missing.length) {
      const p = this.fetch(missing);
      missing.forEach((id) => this.inflight.set(id, p));
      waits.push(p);
    }
    await Promise.all(waits);
  }

  private async fetch(ids: string[]) {
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const rows = must(await sb().from('profiles').select('*').in('id', chunk)) as ProfileRow[];
        // If the pins can't be read the rows are not stored: these people stay "loading" (fail closed).
        await this.adopt(rows).catch((e) => console.warn('people: could not check identity keys', e));
        const infos = must(await sb().from('profile_info').select('*').in('user_id', chunk)) as ProfileInfoRow[];
        infos.forEach((r) => { this.infoRows.set(r.user_id, r); this.infos.delete(r.user_id); });
      }
    } finally {
      ids.forEach((id) => this.inflight.delete(id));
      this.bump();
    }
  }

  /**
   * Find someone by their exact handle. Profiles are only listable by connections (security review D3),
   * so strangers are found through find_profile(), which returns just that one person's public routing
   * data (no account age or moderation status). Once connected, the row comes from the table as usual.
   */
  async byUsername(username: string): Promise<ProfileRow | null> {
    const h = username.trim().toLowerCase();
    for (const r of this.rows.values()) if (r.username === h) return r;
    const { data, error } = await sb().rpc('find_profile', { p_handle: h });
    if (error) throw new Error(error.message);
    const found = ((data ?? []) as Pick<ProfileRow, 'id' | 'username' | 'discoverable' | 'display_name_public' | 'sign_pub' | 'kx_pub' | 'key_version'>[])[0];
    if (!found) return null;
    const full = (await sb().from('profiles').select('*').eq('id', found.id).maybeSingle()).data as ProfileRow | null;
    const row: ProfileRow = full ?? { ...found, status: 'active', suspended_until: null, created_at: '' };
    await this.adopt([row]);
    await this.refreshInfo(row.id);
    return this.rows.get(row.id) ?? null;
  }

  async refreshInfo(id: string) {
    const infos = must(await sb().from('profile_info').select('*').eq('user_id', id)) as ProfileInfoRow[];
    this.infoRows.delete(id);
    infos.forEach((r) => this.infoRows.set(r.user_id, r));
    this.infos.delete(id);
    this.bump();
  }

  /**
   * Call when new keys arrive (e.g. a friendship was just accepted): cached "can't read" results are
   * retried, and profile info we couldn't fetch or decrypt before is re-fetched — before the
   * friendship existed, RLS hid the row, and the owner may since have re-encrypted it to a new epoch.
   */
  invalidateInfos() {
    this.infos.clear();
    this.bump();
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => { void this.refetchUnreadable(); }, 300);
  }
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;

  private async refetchUnreadable() {
    const ids = [...this.rows.keys()].filter((id) => {
      const r = this.infoRows.get(id);
      return !r || !this.keyLookup(r.audience_id, r.epoch);
    });
    if (!ids.length) return;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const infos = must(await sb().from('profile_info').select('*').in('user_id', chunk)) as ProfileInfoRow[];
        infos.forEach((r) => { this.infoRows.set(r.user_id, r); this.infos.delete(r.user_id); });
      }
    } catch { /* offline or signed out: retried on the next key change */ }
    this.bump();
  }

  /**
   * Re-read profiles that changed on the server. Requested when a connection's profile changes (the
   * "profile_info" notice on my private db: topic, see Providers) and when the app comes back to the
   * foreground or reconnects, so a missed notice never leaves a stale name or photo. Bursts are folded
   * into one run.
   */
  requestSync() { this.syncer.request(); }

  /**
   * Compare (user, audience, epoch, updated_at) stamps of everyone cached with the server's and fetch the
   * envelopes of only the rows that changed.
   */
  async syncInfos(): Promise<void> {
    const ids = [...this.rows.keys()];
    if (!ids.length) return;
    const fresh: InfoStamp[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      fresh.push(...(must(await sb().from('profile_info').select('user_id,audience_id,epoch,updated_at').in('user_id', ids.slice(i, i + 100))) as InfoStamp[]));
    }
    const { changed, gone } = staleInfos(this.infoRows, ids, fresh);
    if (!changed.length && !gone.length) return;
    const rows: ProfileInfoRow[] = [];
    for (let i = 0; i < changed.length; i += 100) {
      rows.push(...(must(await sb().from('profile_info').select('*').in('user_id', changed.slice(i, i + 100))) as ProfileInfoRow[]));
    }
    this.applyInfoRows(rows, gone);
  }

  /** Replace cached envelopes (and drop the ones in `gone`), then re-render: each is decrypted again on read. */
  applyInfoRows(rows: readonly ProfileInfoRow[], gone: readonly string[] = []) {
    for (const r of rows) { this.infoRows.set(r.user_id, r); this.infos.delete(r.user_id); }
    for (const id of gone) {
      this.infoRows.delete(id); this.infos.delete(id);
      const paths = this.avatarPaths.get(id);
      this.avatarPaths.delete(id);
      if (paths?.length) this.releaseFiles(paths);
    }
    if (rows.length || gone.length) this.bump();
  }

  private decryptInfo(id: string): ProfileInfo | null {
    if (this.infos.has(id)) return this.infos.get(id) ?? null;
    const row = this.infoRows.get(id);
    const prof = this.rows.get(id);
    let info: ProfileInfo | null = null;
    if (row && prof) {
      const key = this.keyLookup(row.audience_id, row.epoch);
      if (key) {
        try {
          info = openEnvelope<ProfileInfo>({
            header: profileHeader(id, row.audience_id, row.epoch), envelope: row.envelope,
            audienceKey: key, signPub: b64u.decode(prof.sign_pub),
          });
        } catch (e) { console.warn('profile info failed verification', id, e); }
        // Close-friends fields: merged in when this device holds that list's key (lib/social/visibility).
        if (info?.x) {
          const extra = openExtra(id, info.x, this.keyLookup);
          info = { ...info, ...(extra ?? {}) };
          delete info.x;
        }
      }
    }
    this.infos.set(id, info);
    if (info) {
      // A new picture: the old one's decrypted copies are no longer needed.
      const a = info.avatar;
      const now = a ? [a.big?.path, a.med?.path, a.thumb?.path].filter((p): p is string => !!p) : [];
      const dropped = droppedPaths(this.avatarPaths.get(id), now);
      this.avatarPaths.set(id, now);
      if (dropped.length) this.releaseFiles(dropped);
    }
    return info;
  }
}

export const profileHeader = (userId: string, aud: string, epoch: number) =>
  ({ v: 1 as const, type: 'profile_info', id: userId, author: userId, audience: { id: aud, epoch } });

export const people = new People();

/** React hook: re-render when people data changes. */
export function usePeopleVersion(): number {
  return useSyncExternalStore((l) => people.subscribe(l), () => people.version, () => 0);
}

export function usePerson(id: string | null | undefined): Person | null {
  usePeopleVersion();
  if (!id) return null;
  const p = people.person(id);
  if (!p) void people.ensure([id]);
  return p;
}
