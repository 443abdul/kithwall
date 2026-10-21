'use client';
// Who may hand out keys in a circle, event or group chat, as this device last saw it (security re-review
// R-K-2). Stored only in my encrypted vault (namespace "rosterpins"), like identity-key pins.
//
// The roster is server data. Admin grants are signed (lib/keys/authority.ts verifiedAdmins), but the server
// could still, for example, hand a chat to a puppet owner or replay an old grant. So the first time this
// device sees an audience it remembers its key authorities (owner + verified admins); whenever someone new
// appears among them, the circle or chat shows a prominent "new admin" warning until I acknowledge it.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getSession, useSession } from './session';
import { vaultGet, vaultUpdate } from '../settings';
import { people, usePeopleVersion } from '../people';
import { verifiedAdmins, type GrantRow } from './authority';

const NS = 'rosterpins';
const MAX_AUDIENCES = 1000;
type RosterPins = Record<string, string[]>;

let map: RosterPins | null = null;
let loadedFor: string | null = null;
let loading: Promise<RosterPins> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function clean(v: unknown): RosterPins {
  const out: RosterPins = {};
  if (!v || typeof v !== 'object') return out;
  for (const [aud, ids] of Object.entries(v as Record<string, unknown>)) {
    if (UUID.test(aud) && Array.isArray(ids)) out[aud] = ids.filter((x): x is string => typeof x === 'string' && UUID.test(x)).slice(0, 200);
  }
  return out;
}

function load(): Promise<RosterPins> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return Promise.resolve({});
  if (loadedFor === s.userId && map) return Promise.resolve(map);
  if (loading) return loading;
  const uid = s.userId;
  loading = vaultGet<RosterPins>(NS)
    .then((v) => { const m = clean(v); if (getSession().userId === uid) { map = m; loadedFor = uid; emit(); } return m; })
    .finally(() => { loading = null; });
  return loading;
}

async function save(aud: string, ids: string[]): Promise<void> {
  const uid = getSession().userId;
  const next = clean(await vaultUpdate<RosterPins>(NS, (prev) => {
    const m = { ...clean(prev), [aud]: [...new Set(ids)].sort() };
    const keys = Object.keys(m);
    if (keys.length > MAX_AUDIENCES) for (const k of keys.slice(0, keys.length - MAX_AUDIENCES)) if (k !== aud) delete m[k];
    return m;
  }));
  if (getSession().userId === uid) { map = next; loadedFor = uid; emit(); }
}

/** Key authorities of an audience: its owner plus admins with a valid signed grant (checked with trusted keys). */
export function keyAuthorities(aud: { id: string; owner_id: string }, rows: readonly (GrantRow & { status?: string })[]): string[] {
  // people.get() carries the keys this device trusts (pins; my own from my unlocked identity), R-K-1.
  const signPubOf = (id: string) => people.get(id)?.sign_pub;
  const active = rows.filter((r) => r.status === undefined || r.status === 'active');
  return [aud.owner_id, ...verifiedAdmins(aud, active, signPubOf)];
}

/** I made this person an admin myself: no warning about them on this device. */
export async function noteAuthority(aud: string, id: string): Promise<void> {
  const pins = await load().catch(() => null);
  if (!pins || !pins[aud]) return;          // never looked at this audience: pinned on first sight anyway
  if (!pins[aud].includes(id)) await save(aud, [...pins[aud], id]);
}

export interface AuthorityWatch {
  /** Authorities this device hasn't acknowledged yet (empty on first sight: those are pinned silently). */
  fresh: string[];
  acknowledge: () => Promise<void>;
}

/**
 * Compare the audience's current key authorities with what this device saw before. `authorities` null
 * while loading. The first time an audience is seen its authorities are remembered without a warning.
 */
export function useAuthorityWatch(audienceId: string | null | undefined, authorities: string[] | null): AuthorityWatch {
  const { status, userId } = useSession();
  usePeopleVersion();
  useEffect(() => { if (status === 'ready') void load().catch(() => undefined); }, [status, userId]);
  const pins = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (loadedFor === userId ? map : null),
    () => null,
  );
  const key = authorities ? [...authorities].sort().join(',') : null;
  const seen = audienceId && pins ? pins[audienceId] : undefined;
  useEffect(() => {
    if (audienceId && pins && key !== null && !seen) void save(audienceId, key ? key.split(',') : []).catch(() => undefined);
  }, [audienceId, pins, key, seen]);
  return useMemo(() => {
    const now = key ? key.split(',') : [];
    const fresh = seen ? now.filter((id) => id !== userId && !seen.includes(id)) : [];
    return { fresh, acknowledge: () => (audienceId ? save(audienceId, now) : Promise.resolve()) };
  }, [key, seen, userId, audienceId]);
}
