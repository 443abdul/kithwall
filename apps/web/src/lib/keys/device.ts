'use client';
// "Keep me logged in" (spec §3.13): the account master key is stored in IndexedDB,
// encrypted with a NON-EXTRACTABLE WebCrypto AES-GCM key that also lives in IndexedDB.
// Script on this origin can use the key but cannot export it, so a copied database file
// from another machine is useless. Logging out deletes both.

const DB = 'kithwall-device';
const STORE = 'kv';

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

export const deviceStore = {
  async save(userId: string, amk: Uint8Array): Promise<void> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`kithwall/v1/device/${userId}`) },
      key, amk as BufferSource);
    await tx('readwrite', (s) => s.put({ userId, key, iv, ct, at: Date.now() }, 'amk'));
  },
  async load(userId: string): Promise<Uint8Array | null> {
    const rec = await tx<{ userId: string; key: CryptoKey; iv: Uint8Array; ct: ArrayBuffer } | undefined>(
      'readonly', (s) => s.get('amk'));
    if (!rec || rec.userId !== userId) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: new TextEncoder().encode(`kithwall/v1/device/${userId}`) },
      rec.key, rec.ct);
    return new Uint8Array(pt);
  },
  async clear(): Promise<void> {
    await tx('readwrite', (s) => s.delete('amk')).catch(() => undefined);
  },
};
