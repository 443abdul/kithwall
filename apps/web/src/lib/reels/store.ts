'use client';
// Reels: what this device remembers (docs/v2/12-reels.md §3, §4). ONE record per account, in IndexedDB on
// this device only:
//   - the interest profile the feed is ranked with (./rank.ts),
//   - the time controls and today's watch time (./time.ts).
// It is encrypted with my vault key (HKDF of the account key, the same key that protects my settings) and
// bound to my account id, so it opens only after a real unlock. It is NEVER uploaded: nothing in this file
// talks to a server, it is not part of the vault that syncs between my devices, and it is not in the data
// export's server inventory (there is nothing on the server to list). Each device learns by itself.
// Removed by "Reset what reels has learned" (the profile), by signing out and by the panic wipe (all of it).
import { decryptBlob, deriveVaultKey, encryptBlob } from '@kithwall/crypto';
import { useEffect, useSyncExternalStore } from 'react';
import { amk, getSession, onLock, useSession } from '../keys/session';
import { cleanProfile, emptyProfile, type ReelProfile } from './rank';
import { cleanTime, defaultTime, type ReelTime } from './time';

const DB = 'kw-reels';
const STORE = 'kv';
const aad = (userId: string) => `reels/${userId}`;

export interface ReelState { profile: ReelProfile; time: ReelTime; loaded: boolean }
const EMPTY: ReelState = { profile: emptyProfile(), time: defaultTime(), loaded: false };

let state: ReelState = EMPTY;
let owner: string | null = null;
let loading: Promise<ReelState> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** Delete everything reels keeps on this device (signing out, panic wipe). */
export function deleteReelsDatabase(): Promise<void> {
  state = EMPTY; owner = null; loading = null; dirty = false;
  if (timer) { clearTimeout(timer); timer = null; }
  emit();
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}

onLock((reason) => {
  // A lock keeps the (encrypted) record for the next unlock; signing out removes it from the device. The
  // key is already gone when this runs, so a change from the last second or two is not written.
  if (reason === 'sign_out') { void deleteReelsDatabase(); return; }
  if (timer) { clearTimeout(timer); timer = null; }
  state = EMPTY; owner = null; loading = null; dirty = false;
  emit();
});

/** Read my record (once per unlock). A record that can't be opened counts as empty. */
export function loadReelState(): Promise<ReelState> {
  const userId = getSession().userId;
  if (!userId) return Promise.resolve(EMPTY);
  if (state.loaded && owner === userId) return Promise.resolve(state);
  loading ??= (async () => {
    let next: ReelState = { profile: emptyProfile(), time: defaultTime(), loaded: true };
    try {
      const blob = await tx<string | undefined>('readonly', (s) => s.get(`state:${userId}`) as IDBRequest<string | undefined>);
      if (typeof blob === 'string') {
        const raw = JSON.parse(new TextDecoder().decode(decryptBlob(deriveVaultKey(amk()), blob, aad(userId)))) as { profile?: unknown; time?: unknown };
        next = { profile: cleanProfile(raw.profile), time: cleanTime(raw.time), loaded: true };
      }
    } catch { /* no storage, or not this account's record: start empty */ }
    if (getSession().userId !== userId) return EMPTY; // locked or signed out meanwhile
    owner = userId;
    state = next;
    emit();
    return state;
  })().finally(() => { loading = null; });
  return loading;
}

async function persist(): Promise<void> {
  const userId = owner;
  if (!userId || !dirty || getSession().userId !== userId || getSession().status !== 'ready') return;
  dirty = false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, profile: state.profile, time: state.time }));
    const blob = encryptBlob(deriveVaultKey(amk()), bytes, aad(userId));
    await tx('readwrite', (s) => s.put(blob, `state:${userId}`));
  } catch { dirty = true; /* storage blocked or full: kept in memory, tried again on the next change */ }
}

/** Write now (the page is being hidden or closed). */
export function flushReelState(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  return persist();
}

let wired = false;
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushReelState(); });
  window.addEventListener('pagehide', () => { void flushReelState(); });
}

/** Change the record. Saved a moment later (and at once when the page is hidden), never sent anywhere. */
export function updateReelState(fn: (s: ReelState) => Partial<Pick<ReelState, 'profile' | 'time'>>): void {
  if (!state.loaded || !owner) return;
  const patch = fn(state);
  if (patch.profile === undefined && patch.time === undefined) return;
  if ((patch.profile ?? state.profile) === state.profile && (patch.time ?? state.time) === state.time) return;
  state = { ...state, ...patch };
  dirty = true;
  wire();
  timer ??= setTimeout(() => { timer = null; void persist(); }, 1500);
  emit();
}

/** "Reset what reels has learned": forget the profile (time settings stay). */
export async function resetReelProfile(): Promise<void> {
  await loadReelState();
  updateReelState(() => ({ profile: emptyProfile() }));
  await flushReelState();
}

export function getReelState(): ReelState { return state; }

/** My reels record (empty until it is read after an unlock). */
export function useReelState(): ReelState {
  const { status } = useSession();
  useEffect(() => { if (status === 'ready') void loadReelState().catch(() => undefined); }, [status]);
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state, () => EMPTY);
}
