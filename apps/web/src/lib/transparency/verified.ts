'use client';
// Contact verification (safety numbers, docs/v2/03-transparency.md §2).
//
// Which contacts I verified, and the identity key I verified for each, live ONLY in my encrypted vault
// (lib/settings.ts vaultGet/vaultUpdate, namespace "verified"): the server never learns who I verified.
// A contact counts as verified while their published identity key (profiles.sign_pub) is still the
// one I verified. If it changes, they are no longer verified and a warning shows until I verify again
// or clear it.
//
// Exported for other screens (chat headers, profile):
//   useVerified(userId)          → { status: 'loading' | 'none' | 'verified' | 'changed', verifiedAt }
//   useKeyChangeWarning(userId)  → null, or { verifiedAt, changedAt, vouched } when a verified key changed
//   <VerifiedBadge userId={…} /> → small "Verified" (or "Safety number changed") badge, nothing otherwise
import { b64u, safetyNumber } from '@kithwall/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { sb, must } from '../supabase';
import { getSession, useSession } from '../keys/session';
import { vaultGet, vaultUpdate } from '../settings';
import { vouchedChain, type KeyChangeRow } from './chain';

export interface VerifiedEntry {
  /** The identity signing key (base64url) that was verified. */
  k: string;
  /** When it was verified (ISO). */
  at: string;
  /** How: compared in person by QR scan, or by reading/typing the digits. */
  via?: 'qr' | 'digits';
}
export type VerifiedMap = Record<string, VerifiedEntry>;
export type VerifiedStatus = 'loading' | 'none' | 'verified' | 'changed';

const NS = 'verified';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// The in-memory copy of my verified contacts (decrypted from the vault after unlock).

let map: VerifiedMap | null = null;
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function clean(v: unknown): VerifiedMap {
  const out: VerifiedMap = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
    const x = e as Partial<VerifiedEntry> | null;
    if (UUID.test(id) && x && typeof x.k === 'string' && x.k.length === 43 && typeof x.at === 'string') {
      out[id] = { k: x.k, at: x.at, ...(x.via === 'qr' || x.via === 'digits' ? { via: x.via } : {}) };
    }
  }
  return out;
}

/** Decrypt my verified contacts from the vault (once per unlocked account; `force` re-reads). */
export function loadVerified(force = false): Promise<void> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return Promise.resolve();
  if (!force && loadedFor === s.userId && map) return Promise.resolve();
  if (loading && !force) return loading;
  const uid = s.userId;
  loading = vaultGet<VerifiedMap>(NS)
    .then((v) => { if (getSession().userId === uid) { map = clean(v); loadedFor = uid; emit(); } })
    .catch((e) => { console.warn('verified contacts: load failed', e); })
    .finally(() => { loading = null; });
  return loading;
}

export function getVerifiedMap(): VerifiedMap | null {
  return loadedFor === getSession().userId ? map : null;
}

/** All my verified contacts (null until decrypted). */
export function useVerifiedMap(): VerifiedMap | null {
  const { status, userId } = useSession();
  useEffect(() => { if (status === 'ready') void loadVerified(); }, [status, userId]);
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => (loadedFor === userId ? map : null),
    () => null,
  );
}

async function write(fn: (prev: VerifiedMap) => VerifiedMap): Promise<VerifiedMap> {
  const uid = getSession().userId;
  const next = clean(await vaultUpdate<VerifiedMap>(NS, (prev) => fn(clean(prev))));
  if (getSession().userId === uid) { map = next; loadedFor = uid; emit(); }
  return next;
}

/** Remember that I verified this person's current identity key (stored encrypted in my vault). */
export async function markVerified(userId: string, signPub: string, via: VerifiedEntry['via'] = 'digits'): Promise<void> {
  if (!UUID.test(userId) || typeof signPub !== 'string' || signPub.length !== 43) throw new Error('bad input');
  await write((prev) => ({ ...prev, [userId]: { k: signPub, at: new Date().toISOString(), via } }));
}

/** Forget a verification (e.g. after their key changed and I couldn't check yet). */
export async function clearVerified(userId: string): Promise<void> {
  await write((prev) => { const next = { ...prev }; delete next[userId]; return next; });
}

// ---------------------------------------------------------------------------------------------
// Their current published identity key, fresh from the server (not the people cache, which can be
// minutes old: a key change must show up).

export interface IdentityKeyRow { id: string; username: string; sign_pub: string; kx_pub: string; key_version: number }

export const identityKeyQuery = (userId: string) => ['identity-key', userId] as const;

export async function fetchIdentityKey(userId: string): Promise<IdentityKeyRow | null> {
  return (await sb().from('profiles').select('id, username, sign_pub, kx_pub, key_version').eq('id', userId).maybeSingle()).data as IdentityKeyRow | null;
}

export function useIdentityKey(userId: string | null | undefined, enabled = true) {
  const { status } = useSession();
  return useQuery({
    queryKey: identityKeyQuery(userId ?? ''),
    enabled: enabled && status === 'ready' && !!userId && UUID.test(userId),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    queryFn: () => fetchIdentityKey(userId!),
  });
}

/** Re-read someone's key now (e.g. right before marking them verified). */
export function useRefreshIdentityKey() {
  const qc = useQueryClient();
  return (userId: string) => qc.fetchQuery({ queryKey: identityKeyQuery(userId), queryFn: () => fetchIdentityKey(userId), staleTime: 0 });
}

// ---------------------------------------------------------------------------------------------
// Hooks for other screens

export interface Verified { status: VerifiedStatus; verifiedAt: string | null; entry: VerifiedEntry | null }

export function useVerified(userId: string | null | undefined): Verified {
  const { userId: me } = useSession();
  const all = useVerifiedMap();
  const entry = userId && all ? all[userId] ?? null : null;
  const key = useIdentityKey(userId, !!entry);
  if (!userId || userId === me) return { status: 'none', verifiedAt: null, entry: null };
  if (!all) return { status: 'loading', verifiedAt: null, entry: null };
  if (!entry) return { status: 'none', verifiedAt: null, entry: null };
  if (key.isPending) return { status: 'loading', verifiedAt: entry.at, entry };
  // An account that no longer exists keeps the badge off but isn't a "key change".
  if (!key.data) return { status: 'none', verifiedAt: entry.at, entry };
  return { status: key.data.sign_pub === entry.k ? 'verified' : 'changed', verifiedAt: entry.at, entry };
}

export interface KeyChangeWarning {
  verifiedAt: string;
  /** When the server recorded the newest key change, if it did. */
  changedAt: string | null;
  /** True when a chain of key changes signed by the verified key leads to the current key. */
  vouched: boolean;
}

export { vouchedChain };

export function useKeyChangeWarning(userId: string | null | undefined): KeyChangeWarning | null {
  const v = useVerified(userId);
  const changed = v.status === 'changed' && !!userId && !!v.entry;
  const key = useIdentityKey(userId, changed);
  const log = useQuery({
    queryKey: ['key-changes', userId],
    enabled: changed,
    staleTime: 60_000,
    queryFn: async () => must(await sb().from('key_changes').select('change, sig, created_at').eq('user_id', userId!)
      .order('created_at', { ascending: true }).limit(50)) as KeyChangeRow[],
  });
  return useMemo(() => {
    if (!changed || !v.entry || !key.data) return null;
    const rows = log.data ?? [];
    return {
      verifiedAt: v.entry.at,
      changedAt: rows.length ? rows[rows.length - 1]!.created_at : null,
      vouched: vouchedChain(v.entry.k, key.data.sign_pub, rows),
    };
  }, [changed, v.entry, key.data, log.data]);
}

/** The 60-digit safety number between me and this person (null until both keys are known). */
export function useSafetyNumber(userId: string | null | undefined): { number: string | null; theirKey: IdentityKeyRow | null; loading: boolean } {
  const { userId: me, profile } = useSession();
  const theirs = useIdentityKey(userId);
  const mine = useIdentityKey(me);
  const myKey = mine.data?.sign_pub ?? profile?.sign_pub ?? null;
  const number = useMemo(() => {
    if (!me || !myKey || !theirs.data || !userId || userId === me) return null;
    try {
      return safetyNumber({ userId: me, signPub: b64u.decode(myKey) }, { userId, signPub: b64u.decode(theirs.data.sign_pub) });
    } catch { return null; }
  }, [me, myKey, theirs.data, userId]);
  return { number, theirKey: theirs.data ?? null, loading: theirs.isPending || (!myKey && mine.isPending) };
}

// ---------------------------------------------------------------------------------------------

/**
 * A small badge next to a name: "Verified" while the safety number I checked still holds,
 * "Safety number changed" when their key changed since, nothing otherwise.
 * Styles: styles/v2/transparency.css (.k-verified).
 */
export function VerifiedBadge({ userId, showChanged = true, label = false }: { userId: string | null | undefined; showChanged?: boolean; label?: boolean }) {
  const t = useT();
  const v = useVerified(userId);
  if (v.status === 'verified') {
    const text = t('verify.badge');
    return createElement('span', { className: 'k-verified', title: t('verify.badgeTitle'), role: 'img', 'aria-label': t('verify.badgeTitle') },
      createElement(Icon, { name: 'shield' }), label ? createElement('span', { 'aria-hidden': true }, text) : null);
  }
  if (v.status === 'changed' && showChanged) {
    const text = t('verify.changedBadge');
    return createElement('span', { className: 'k-verified k-verified-changed', title: text, role: 'img', 'aria-label': text },
      createElement(Icon, { name: 'alert' }), label ? createElement('span', { 'aria-hidden': true }, text) : null);
  }
  return null;
}
