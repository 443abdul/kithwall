'use client';
// The service worker's copy of the hidden-chat list (docs/v2/03-safety.md §6). Push payloads are
// "who + what" and name the conversation; the service worker (public/sw.js) can't read the encrypted
// vault, so it gets salted SHA-256 hashes of the hidden conversation ids in IndexedDB and shows a
// generic notification ("You have new activity") for those chats. The hashes only stop casual
// reading: anyone holding a conversation id can test it against them.
// In the Kithwall app the same hashes are also handed to the native notification code (lib/native/push.ts),
// which applies the same rule before showing a decrypted push.
import { isNative } from '../native';

const DB = 'kithwall-sw';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function b64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Same derivation as public/sw.js hiddenHash(). */
export async function hiddenHash(salt: string, conversationId: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${conversationId}`)));
}

export async function writeSwHidden(ids: string[]): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (!ids.length) { await clearSwHidden(); return; }
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hashes = await Promise.all(ids.map((id) => hiddenHash(salt, id)));
  if (isNative()) await import('../native/push').then((m) => m.nativeSetHidden(salt, hashes)).catch(() => undefined);
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put({ salt, hashes }, 'hidden');
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}

export function clearSwHidden(): Promise<void> {
  if (isNative()) void import('../native/push').then((m) => m.nativeClearHidden()).catch(() => undefined);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
