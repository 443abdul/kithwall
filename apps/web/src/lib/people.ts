'use client';
// People directory: public routing data (username, public keys) plus each person's
// encrypted profile info, decrypted when we hold the key for their friends audience.
import { b64u, openEnvelope, type Envelope } from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { sb, must } from './supabase';
import type { ProfileInfo, ProfileRow } from './types';

interface ProfileInfoRow { user_id: string; audience_id: string; epoch: number; envelope: Envelope; updated_at: string }

export interface Person extends ProfileRow {
  info: ProfileInfo | null;      // decrypted profile info if we can read it
  name: string;                  // best available display name
}

type KeyLookup = (aud: string, epoch: number) => Uint8Array | null;

class People {
  private rows = new Map<string, ProfileRow>();
  private infos = new Map<string, ProfileInfo | null>();
  private infoRows = new Map<string, ProfileInfoRow>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private keyLookup: KeyLookup = () => null;
  version = 0;

  setKeyLookup(fn: KeyLookup) { this.keyLookup = fn; }
  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private bump() { this.version++; this.listeners.forEach((l) => l()); }

  get(id: string): ProfileRow | undefined { return this.rows.get(id); }

  person(id: string): Person | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const info = this.decryptInfo(id);
    return { ...row, info, name: info?.name || row.display_name_public || row.username };
  }

  /** Fetch any missing profile rows (and their encrypted info) in batches. */
  async ensure(ids: Iterable<string>): Promise<void> {
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
        rows.forEach((r) => this.rows.set(r.id, r));
        const infos = must(await sb().from('profile_info').select('*').in('user_id', chunk)) as ProfileInfoRow[];
        infos.forEach((r) => { this.infoRows.set(r.user_id, r); this.infos.delete(r.user_id); });
      }
    } finally {
      ids.forEach((id) => this.inflight.delete(id));
      this.bump();
    }
  }

  async byUsername(username: string): Promise<ProfileRow | null> {
    for (const r of this.rows.values()) if (r.username === username.toLowerCase()) return r;
    const row = (await sb().from('profiles').select('*').eq('username', username.toLowerCase()).maybeSingle()).data as ProfileRow | null;
    if (row) { this.rows.set(row.id, row); await this.refreshInfo(row.id); }
    return row;
  }

  async refreshInfo(id: string) {
    const infos = must(await sb().from('profile_info').select('*').eq('user_id', id)) as ProfileInfoRow[];
    this.infoRows.delete(id);
    infos.forEach((r) => this.infoRows.set(r.user_id, r));
    this.infos.delete(id);
    this.bump();
  }

  /** Call when new keys arrive so cached "can't read" results are retried. */
  invalidateInfos() { this.infos.clear(); this.bump(); }

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
      }
    }
    this.infos.set(id, info);
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
