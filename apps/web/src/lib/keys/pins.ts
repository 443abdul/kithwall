'use client';
// Pinned identity keys of my contacts (security review K2), stored only in my encrypted vault
// (namespace "keypins"): the server never learns whose keys I pinned. Logic: ./pinsCore.ts.
//
//   sealGate(recipients)   → the recipients this device may seal new keys to right now (TOFU-pins new ones)
//   useIdentityChange(id)  → null, or the unacknowledged change of that person's identity keys
//   acceptIdentityChange   → acknowledge it (re-pin), after which sharing resumes
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { sb, must } from '../supabase';
import { getSession, useSession } from './session';
import { vaultGet, vaultUpdate } from '../settings';
import { cleanPins, maySealTo, pinStatus, vouchedFrom, type KeyChangeLogRow, type Pin, type PinMap } from './pinsCore';

const NS = 'keypins';
let map: PinMap | null = null;
let loadedFor: string | null = null;
let loading: Promise<PinMap> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Decrypt my pins from the vault (once per unlocked account). */
export function loadPins(force = false): Promise<PinMap> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return Promise.resolve({});
  if (!force && loadedFor === s.userId && map) return Promise.resolve(map);
  if (loading && !force) return loading;
  const uid = s.userId;
  loading = vaultGet<PinMap>(NS)
    .then((v) => { const m = cleanPins(v); if (getSession().userId === uid) { map = m; loadedFor = uid; emit(); } return m; })
    .finally(() => { loading = null; });
  return loading;
}

async function write(fn: (prev: PinMap) => PinMap): Promise<void> {
  const uid = getSession().userId;
  const next = cleanPins(await vaultUpdate<PinMap>(NS, (prev) => fn(cleanPins(prev))));
  if (getSession().userId === uid) { map = next; loadedFor = uid; emit(); }
}

/** Trust on first use: pin people I have never seen before (never overwrites an existing pin). */
export async function pinIfNew(entries: { id: string; s: string; x: string }[]): Promise<void> {
  const cur = await loadPins();
  const fresh = entries.filter((e) => !cur[e.id]);
  if (!fresh.length) return;
  const at = new Date().toISOString();
  await write((prev) => {
    const next = { ...prev };
    for (const e of fresh) if (!next[e.id]) next[e.id] = { s: e.s, x: e.x, at };
    return next;
  });
}

/** The user acknowledged (or verified) these keys for this person. */
export async function acceptIdentityChange(id: string, s: string, x: string): Promise<void> {
  await write((prev) => ({ ...prev, [id]: { s, x, at: new Date().toISOString() } }));
}

export async function keyChangeLog(userId: string): Promise<KeyChangeLogRow[]> {
  return must(await sb().from('key_changes').select('change, sig, created_at').eq('user_id', userId)
    .order('created_at', { ascending: true }).limit(50)) as KeyChangeLogRow[];
}

async function verifiedKeys(): Promise<Record<string, string>> {
  const v = await vaultGet<Record<string, { k?: unknown }>>('verified').catch(() => undefined);
  const out: Record<string, string> = {};
  for (const [id, e] of Object.entries(v ?? {})) if (e && typeof e.k === 'string') out[id] = e.k;
  return out;
}

const blocked = new Set<string>();
/** People whose new keys this device is currently holding back (for diagnostics and UI). */
export function sealingPausedFor(id: string): boolean { return blocked.has(id); }

/**
 * Of these recipients (current published keys), which may receive newly sealed keys? New contacts are
 * pinned on the way (TOFU). Never throws: if the vault can't be read, nothing new is pinned and only
 * recipients whose pin already matches are allowed.
 */
export async function sealGate(recipients: { id: string; s: string; x: string }[]): Promise<Set<string>> {
  const ok = new Set<string>();
  if (!recipients.length) return ok;
  let pins: PinMap;
  let verified: Record<string, string>;
  try { [pins, verified] = await Promise.all([loadPins(), verifiedKeys()]); } catch { return ok; }
  const fresh: { id: string; s: string; x: string }[] = [];
  for (const r of recipients) {
    const pin: Pin | undefined = pins[r.id];
    const st = pinStatus(pin, r.s, r.x);
    if (st === 'new') fresh.push(r);
    let vouched = false;
    if (st === 'changed' && !verified[r.id]) {
      vouched = vouchedFrom(pin!, r.s, r.x, await keyChangeLog(r.id).catch(() => []));
    }
    if (maySealTo({ pin, signPub: r.s, kxPub: r.x, verifiedKey: verified[r.id] ?? null, vouched })) { ok.add(r.id); blocked.delete(r.id); }
    else { blocked.add(r.id); console.warn('Kithwall: not sharing new keys with a contact whose identity key changed until you confirm it', r.id); }
  }
  if (fresh.length) await pinIfNew(fresh).catch((e) => console.warn('key pins', e));
  return ok;
}

/** All my pins (null until decrypted). */
export function usePins(): PinMap | null {
  const { status, userId } = useSession();
  useEffect(() => { if (status === 'ready') void loadPins().catch(() => undefined); }, [status, userId]);
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (loadedFor === userId ? map : null),
    () => null,
  );
}

export interface IdentityChange {
  pinnedAt: string;
  /** Signed by the pinned key (a rotation made with their old device). */
  vouched: boolean;
  signPub: string;
  kxPub: string;
}

/**
 * The unacknowledged identity-key change of this person, or null. Pins the person on first sight.
 * `current` are their published keys (fresh from the server, e.g. useIdentityKey()).
 */
export function useIdentityChange(userId: string | null | undefined, current: { sign_pub: string; kx_pub: string } | null | undefined): IdentityChange | null {
  const { userId: me } = useSession();
  const pins = usePins();
  const pin = userId && pins ? pins[userId] : undefined;
  const st = userId && current && pins ? pinStatus(pin, current.sign_pub, current.kx_pub) : null;
  useEffect(() => {
    if (st === 'new' && userId && current && userId !== me) void pinIfNew([{ id: userId, s: current.sign_pub, x: current.kx_pub }]).catch(() => undefined);
  }, [st, userId, current, me]);
  const log = useQuery({
    queryKey: ['key-changes', userId],
    enabled: st === 'changed',
    staleTime: 60_000,
    queryFn: () => keyChangeLog(userId!),
  });
  if (st !== 'changed' || !pin || !current || userId === me) return null;
  return {
    pinnedAt: pin.at,
    vouched: log.data ? vouchedFrom(pin, current.sign_pub, current.kx_pub, log.data) : false,
    signPub: current.sign_pub, kxPub: current.kx_pub,
  };
}
