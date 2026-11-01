'use client';
// Opening Kithwall without a connection (Kit Drop, docs/v2/08-censorship.md §5 "Offline app shell").
//
// Unlocking needs my key bundle, and reading needs the audience keys and my contacts' trusted identity keys,
// all of which normally come from the server on every start. This keeps the last copy on this device:
//  - 'bundle:<me>' and 'profile:<me>': my key bundle (the server's copy: private keys wrapped under my
//    passphrase / recovery key / AMK, never plaintext) and my own profile row (public routing data).
//  - 'snap:<me>': the audience keys this device adopted, my default audiences and the people rows it
//    trusts (identity keys as pinned / vouched, with their sealed profile info), as one blob encrypted
//    under my cache key (HKDF of the AMK, spec §3.13), so it opens only after a real unlock.
// Written while the app is online and unlocked; read only when the server can't be reached. Deleted when
// signing out and by the panic wipe (every IndexedDB database of the origin). Nothing here ever leaves the
// device.
import { decryptBlob, deriveCacheKey, encryptBlob, type KeyBundle } from '@kithwall/crypto';
import type { ProfileRow } from '../types';
import { keyring, type KeyringSnapshot } from './keyring';
import { people, type PeopleSnapshot } from '../people';

const DB = 'kw-offline';
const STORE = 'kv';
const aad = (userId: string) => `offline-snapshot/${userId}`;

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
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}

// Writes only for the account that is signed in and was opened online (allowWrites); signing out turns them
// off before deleting, so a request or snapshot still in flight can't write anything back afterwards.
let writer: string | null = null;
const put = async (userId: string, key: string, value: unknown) => {
  if (writer !== userId) return;
  // Checked again once the database is open (signing out may have started meanwhile): then only a read.
  await tx('readwrite', (s) => (writer === userId ? s.put(value, key) : s.getKey(key)) as IDBRequest<IDBValidKey | undefined>);
};
const get = <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);

export interface OfflineSnapshot { v: 1; at: string; keyring: KeyringSnapshot; people: PeopleSnapshot }

export const offlineStore = {
  /** The account opened online (lib/keys/session becomeReady); only its records are written. */
  allowWrites(userId: string) { writer = userId; },
  saveBundle: (userId: string, bundle: KeyBundle) => put(userId, `bundle:${userId}`, bundle).catch(() => undefined),
  saveProfile: (userId: string, profile: ProfileRow) => put(userId, `profile:${userId}`, profile).catch(() => undefined),
  bundle: (userId: string) => get<KeyBundle>(`bundle:${userId}`).catch(() => undefined),
  profile: (userId: string) => get<ProfileRow>(`profile:${userId}`).catch(() => undefined),

  /** Decrypt my last snapshot with the AMK. Undefined if there is none or it doesn't open. */
  async snapshot(userId: string, amk: Uint8Array): Promise<OfflineSnapshot | undefined> {
    const blob = await get<string>(`snap:${userId}`).catch(() => undefined);
    if (typeof blob !== 'string') return undefined;
    try {
      const s = JSON.parse(new TextDecoder().decode(decryptBlob(deriveCacheKey(amk), blob, aad(userId)))) as OfflineSnapshot;
      return s?.v === 1 && s.keyring && s.people ? s : undefined;
    } catch { return undefined; }
  },

  async saveSnapshot(userId: string, amk: Uint8Array): Promise<void> {
    const kr = keyring.snapshot();
    if (!kr) return;
    const snap: OfflineSnapshot = { v: 1, at: new Date().toISOString(), keyring: kr, people: people.snapshot() };
    const blob = encryptBlob(deriveCacheKey(amk), new TextEncoder().encode(JSON.stringify(snap)), aad(userId));
    await put(userId, `snap:${userId}`, blob);
  },

  /** Everything (signing out, panic wipe). Nothing is written again until an account opens online. */
  clear(): Promise<void> {
    writer = null;
    return new Promise((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(DB);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch { resolve(); }
    });
  },
};

/**
 * Keep the snapshot current while online and unlocked: written a few seconds after keys or people change.
 * Returns the stop function.
 */
export function trackOfflineSnapshot(userId: string, amk: () => Uint8Array | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    const k = amk();
    if (k) void offlineStore.saveSnapshot(userId, k).catch((e) => console.warn('offline snapshot', (e as Error).message));
  };
  const soon = () => { if (!timer) timer = setTimeout(save, 4000); };
  const offK = keyring.subscribe(soon);
  const offP = people.subscribe(soon);
  soon();
  return () => { offK(); offP(); if (timer) clearTimeout(timer); timer = null; };
}
