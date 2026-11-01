'use client';
// Kit Drop: Kithwall without the internet (shutdowns, no data, no signal).
//
//  - Outbox: a post written while offline is sealed on this device exactly as if it were sent (end-to-end
//    encrypted to its audience, signed by me) and kept here; it goes out by itself when the connection is
//    back (flushOutbox).
//  - Kit Drop file: my waiting posts plus recent posts this device already has, in one file signed by my
//    identity key. Pass it to someone nearby however works (Quick Share, Bluetooth, USB, SD card).
//  - Opening one: the file's signature is checked against the sender's identity key, and every post again
//    against its author's (readPost), then decrypted with the keys the reader's device holds. People see
//    only posts they could see on Kithwall anyway; a file can't be forged or altered.
// Everything here is ciphertext at rest (IndexedDB, wiped by the panic wipe like everything else).
import { b64u, canonicalJson, signDetached, verifyDetached } from '@kithwall/crypto';
import { identity, me } from '../keys/session';
import { people } from '../people';
import { insertSealedPost, preparePosts, type SealedPost } from '../content';
import { isOfflineError } from '../net/offline';
import type { PostRow } from '../types';

const DB = 'kw-kitdrop';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 600;

// ------------------------------------------------------------------------------------- storage
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('inbox')) d.createObjectStore('inbox', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: 'outbox' | 'inbox', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => { d.close(); resolve(r ? (r.result as T) : undefined); };
    t.onerror = () => { d.close(); reject(t.error); };
  });
}

// ------------------------------------------------------------------------------------- outbox
export interface OutboxItem { id: string; owner: string; queuedAt: string; post: SealedPost }

export async function queuePost(post: SealedPost): Promise<void> {
  await tx('outbox', 'readwrite', (s) => { s.put({ id: post.id, owner: me(), queuedAt: new Date().toISOString(), post } satisfies OutboxItem); });
}

export async function outboxItems(): Promise<OutboxItem[]> {
  const all = ((await tx<OutboxItem[]>('outbox', 'readonly', (s) => s.getAll())) ?? []) as OutboxItem[];
  return all.filter((x) => x.owner === me()).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function dropOutboxItem(id: string): Promise<void> {
  await tx('outbox', 'readwrite', (s) => { s.delete(id); });
}

let flushing: Promise<number> | null = null;
/** Send my waiting posts (oldest first). Returns how many went out. Safe to call often. */
export function flushOutbox(): Promise<number> {
  flushing ??= (async () => {
    let sent = 0;
    for (const item of await outboxItems()) {
      try { await insertSealedPost(item.post); await dropOutboxItem(item.id); sent++; }
      catch (e) { if (isOfflineError(e)) break; /* still offline */ }
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}


// ------------------------------------------------------------------------------------- files
export interface KitDropFile {
  v: 1; kind: 'kithwall-kitdrop';
  from: string; made: string;
  /** Post rows as stored on Kithwall (ciphertext envelopes; created_at may be the time it was written offline). */
  posts: PostRow[];
  sig: string;
}

const sigMessage = (f: Omit<KitDropFile, 'sig'>) => canonicalJson({ d: 'kithwall/v1/kitdrop', v: f.v, from: f.from, made: f.made, posts: f.posts });

/** Build my signed Kit Drop file: my waiting posts plus `recent` posts this device has. */
export async function makeKitDrop(recent: PostRow[]): Promise<{ blob: Blob; count: number; name: string }> {
  const now = new Date().toISOString();
  const waiting: PostRow[] = (await outboxItems()).map((o) => ({ ...(o.post as PostRow), created_at: o.queuedAt, edited_at: null }));
  const seen = new Set<string>();
  const posts = [...waiting, ...recent].filter((p) => !seen.has(p.id) && !!seen.add(p.id)).slice(0, MAX_ITEMS);
  const body = { v: 1 as const, kind: 'kithwall-kitdrop' as const, from: me(), made: now, posts: posts.map(stripRow) };
  const file: KitDropFile = { ...body, sig: signDetached(sigMessage(body), identity().signPriv) };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  return { blob, count: posts.length, name: `kithwall-kitdrop-${now.slice(0, 10)}.kwd` };
}

/** Only the columns a reader needs (and that the server would show them anyway). */
function stripRow(p: PostRow): PostRow {
  return {
    id: p.id, author_id: p.author_id, wall_owner_id: p.wall_owner_id, group_id: p.group_id, event_id: p.event_id,
    kind: p.kind, is_public: p.is_public, audience_id: p.audience_id, epoch: p.epoch, shared_post_id: p.shared_post_id,
    envelope: p.envelope, created_at: p.created_at, edited_at: p.edited_at ?? null,
  };
}

export interface OpenedKitDrop { id: string; from: string; made: string; posts: PostRow[]; verified: boolean; receivedAt: string }

/** Read and check a Kit Drop file. Throws on anything malformed; `verified` says whether the sender's signature checked out. */
export async function openKitDrop(file: File): Promise<OpenedKitDrop> {
  if (file.size > MAX_FILE_BYTES) throw new Error('too_big');
  let f: KitDropFile;
  try { f = JSON.parse(await file.text()) as KitDropFile; } catch { throw new Error('not_kitdrop'); }
  if (!f || f.kind !== 'kithwall-kitdrop' || f.v !== 1 || typeof f.from !== 'string' || typeof f.made !== 'string'
    || typeof f.sig !== 'string' || !Array.isArray(f.posts) || f.posts.length > MAX_ITEMS) throw new Error('not_kitdrop');
  const posts = f.posts.filter((p) => p && typeof p.id === 'string' && typeof p.author_id === 'string' && p.envelope && typeof p.created_at === 'string').map(stripRow);
  await people.ensure([f.from, ...posts.map((p) => p.author_id)]).catch(() => undefined);
  const sender = people.get(f.from);
  let verified = false;
  try { verified = !!sender && verifyDetached(f.sig, sigMessage({ v: 1, kind: 'kithwall-kitdrop', from: f.from, made: f.made, posts: f.posts }), b64u.decode(sender.sign_pub)); } catch { verified = false; }
  await preparePosts(posts).catch(() => undefined);
  const opened: OpenedKitDrop = { id: `${f.from}:${f.made}`, from: f.from, made: f.made, posts, verified, receivedAt: new Date().toISOString() };
  await tx('inbox', 'readwrite', (s) => { s.put({ ...opened, owner: me() }); });
  return opened;
}

export async function receivedKitDrops(): Promise<OpenedKitDrop[]> {
  const all = ((await tx<(OpenedKitDrop & { owner: string })[]>('inbox', 'readonly', (s) => s.getAll())) ?? []);
  const mine = all.filter((x) => x.owner === me()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  await people.ensure(mine.flatMap((x) => [x.from, ...x.posts.map((p) => p.author_id)])).catch(() => undefined);
  return mine;
}

export async function forgetKitDrop(id: string): Promise<void> {
  await tx('inbox', 'readwrite', (s) => { s.delete(id); });
}
