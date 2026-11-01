'use client';
// Kit Drop: Kithwall without the internet (shutdowns, no data, no signal).
//
//  - Outbox: a post written while offline is sealed on this device exactly as if it were sent (end-to-end
//    encrypted to its audience, signed by me) and kept here; it goes out by itself when the connection is
//    back (flushOutbox). Its photos are re-encoded and encrypted exactly as for a normal upload and wait here
//    as ciphertext too; on flush they are uploaded first and the post is inserted only once all of them are
//    stored. (Videos can't wait: they are too big to keep and pass on.)
//  - Kit Drop file: my waiting posts plus recent posts this device already has, with their photos (the
//    medium size, as ciphertext, up to MAX_MEDIA_BYTES), in one file signed by my identity key
//    (./kitdropFormat). Pass it to someone nearby however works (Quick Share, Bluetooth, USB, SD card).
//  - Opening one: the file's signature is checked against the sender's identity key, and every post again
//    against its author's (readPost), then decrypted with the keys the reader's device holds; photos with the
//    key inside their post. People see only posts they could see on Kithwall anyway; a file can't be forged
//    or altered.
// Everything here is ciphertext at rest (IndexedDB, wiped by the panic wipe like everything else).
import { b64u } from '@kithwall/crypto';
import { identity, me } from '../keys/session';
import { people } from '../people';
import { insertSealedPost, preparePosts, readPost, type SealedPost } from '../content';
import { fileCiphertext, holdCiphertext, isHeld, linkMedia, releaseCiphertext, uploadSealed } from '../media';
import { isOfflineError } from '../net/offline';
import type { PostRow } from '../types';
import {
  checkKitDrop, KITDROP_KIND, KITDROP_MIME, MAX_FILE_BYTES, MAX_ITEMS, MAX_MEDIA_BYTES, MAX_MEDIA_ITEMS, mediaEntry, parseKitDrop,
  signKitDrop, stripRow, type KitDropMedia,
} from './kitdropFormat';

export { KITDROP_MIME } from './kitdropFormat';

const DB = 'kw-kitdrop';

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

/** Delete the whole Kit Drop store (panic wipe; browsers without indexedDB.databases()). */
export function deleteKitDropDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}

/** Photo ciphertext kept on this device, by storage path. */
export interface HeldFile { path: string; cipher: Blob }

// ------------------------------------------------------------------------------------- outbox
export interface OutboxItem {
  id: string; owner: string; queuedAt: string; post: SealedPost;
  /** Encrypted photo files the post refers to, not uploaded yet. */
  media?: HeldFile[];
  /** Paths of `media` already uploaded by an earlier, interrupted flush. */
  uploaded?: string[];
}

/** Keep a sealed post (and its encrypted photos; `uploaded`: the ones already stored) until there is a connection. */
export async function queuePost(post: SealedPost, media: HeldFile[] = [], uploaded: string[] = []): Promise<void> {
  const item: OutboxItem = { id: post.id, owner: me(), queuedAt: new Date().toISOString(), post, ...(media.length ? { media, uploaded } : {}) };
  await tx('outbox', 'readwrite', (s) => { s.put(item); });
  holdCiphertext(media);
}

export async function outboxItems(): Promise<OutboxItem[]> {
  const all = ((await tx<OutboxItem[]>('outbox', 'readonly', (s) => s.getAll())) ?? []) as OutboxItem[];
  const mine = all.filter((x) => x.owner === me()).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  holdCiphertext(mine.flatMap((x) => x.media ?? []));
  return mine;
}

export async function dropOutboxItem(id: string): Promise<void> {
  const item = (await tx<OutboxItem>('outbox', 'readonly', (s) => s.get(id))) as OutboxItem | undefined;
  await tx('outbox', 'readwrite', (s) => { s.delete(id); });
  releaseCiphertext((item?.media ?? []).map((m) => m.path));
}

/** One waiting post: upload its photos (skipping ones an earlier attempt stored), then insert it, then link them. */
async function send(item: OutboxItem): Promise<void> {
  const media = item.media ?? [];
  const done = new Set(item.uploaded ?? []);
  for (const m of media) {
    if (done.has(m.path)) continue;
    await uploadSealed(m.path, m.cipher);
    done.add(m.path);
    item.uploaded = [...done];
    await tx('outbox', 'readwrite', (s) => { s.put(item); });
  }
  // Never before every photo is stored: a post must not point at files that don't exist.
  await insertSealedPost(item.post);
  if (media.length) await linkMedia(media.map((m) => m.path), { postId: item.id });
}

let flushing: Promise<number> | null = null;
/** Send my waiting posts (oldest first). Returns how many went out. Safe to call often. */
export function flushOutbox(): Promise<number> {
  flushing ??= (async () => {
    let sent = 0;
    for (const item of await outboxItems()) {
      try { await send(item); await dropOutboxItem(item.id); sent++; }
      catch (e) { if (isOfflineError(e)) break; /* still offline */ }
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}


// ------------------------------------------------------------------------------------- files
export interface MadeKitDrop {
  blob: Blob; count: number; name: string;
  /** Photos carried, photos left out (over the size cap or not on this device), posts with a video (never carried). */
  photos: number; photosLeft: number; videos: number;
}

/** Build my signed Kit Drop file: my waiting posts plus `recent` posts this device has, with their photos. */
export async function makeKitDrop(recent: PostRow[]): Promise<MadeKitDrop> {
  const now = new Date().toISOString();
  const waiting: PostRow[] = (await outboxItems()).map((o) => ({ ...(o.post as PostRow), created_at: o.queuedAt, edited_at: null }));
  const seen = new Set<string>();
  const posts = [...waiting, ...recent].filter((p) => !seen.has(p.id) && !!seen.add(p.id)).slice(0, MAX_ITEMS);
  const carried = await carryPhotos(posts);
  const file = signKitDrop({ v: 2, kind: KITDROP_KIND, from: me(), made: now, posts: posts.map(stripRow), media: carried.media }, identity().signPriv);
  const blob = new Blob([JSON.stringify(file)], { type: KITDROP_MIME });
  return { blob, count: posts.length, name: `kithwall-kitdrop-${now.slice(0, 10)}.kwd`, photos: carried.media.length, photosLeft: carried.left, videos: carried.videos };
}

/**
 * The medium-size ciphertext of the photos in these posts (oldest waiting posts first, then recent ones),
 * until MAX_MEDIA_BYTES: the copies held on this device, else the stored ones while there is a connection.
 */
async function carryPhotos(posts: PostRow[]): Promise<{ media: KitDropMedia[]; left: number; videos: number }> {
  const media: KitDropMedia[] = [];
  const seen = new Set<string>();
  let total = 0, left = 0, videos = 0, online = true;
  for (const p of posts) {
    const d = readPost(p);
    if (!d.ok) continue;
    if (d.value.video) videos++;
    for (const photo of d.value.photos ?? []) {
      const ref = photo.files?.med;
      if (!ref?.path || seen.has(ref.path)) continue;
      seen.add(ref.path);
      if (media.length >= MAX_MEDIA_ITEMS || total >= MAX_MEDIA_BYTES || (!online && !isHeld(ref.path))) { left++; continue; }
      let cipher: Blob | null = null;
      try {
        cipher = await within(fileCiphertext(ref), 8000);
      } catch (e) {
        // No connection: from now on only the copies held here.
        if (isOfflineError(e) || (e as Error).message === 'timeout') online = false;
      }
      if (!cipher || total + cipher.size > MAX_MEDIA_BYTES) { left++; continue; }
      const bytes = new Uint8Array(await cipher.arrayBuffer());
      total += bytes.byteLength;
      media.push(await mediaEntry(ref.path, bytes));
    }
  }
  return { media, left, videos };
}

/** `p`, or a 'timeout' rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

export interface OpenedKitDrop {
  id: string; from: string; made: string; posts: PostRow[]; verified: boolean; receivedAt: string;
  /** Photo ciphertext carried in the file (v2). */
  media?: HeldFile[];
}

/** Read and check a Kit Drop file. Throws on anything malformed; `verified` says whether the sender's signature checked out. */
export async function openKitDrop(file: Blob): Promise<OpenedKitDrop> {
  if (file.size > MAX_FILE_BYTES) throw new Error('too_big');
  const f = parseKitDrop(await file.text());
  await people.ensure([f.from, ...f.posts.map((p) => p?.author_id).filter((x): x is string => typeof x === 'string')]).catch(() => undefined);
  const sender = people.get(f.from);
  let signPub: Uint8Array | null = null;
  try { signPub = sender ? b64u.decode(sender.sign_pub) : null; } catch { signPub = null; }
  const checked = await checkKitDrop(f, signPub);
  await preparePosts(checked.posts).catch(() => undefined);
  const media = checked.media.map((m) => ({ path: m.path, cipher: new Blob([m.cipher as BlobPart], { type: 'application/octet-stream' }) }));
  const opened: OpenedKitDrop = {
    id: `${f.from}:${f.made}`, from: f.from, made: f.made, posts: checked.posts, verified: checked.verified,
    receivedAt: new Date().toISOString(), ...(media.length ? { media } : {}),
  };
  await tx('inbox', 'readwrite', (s) => { s.put({ ...opened, owner: me() }); });
  holdCiphertext(media);
  return opened;
}

export async function receivedKitDrops(): Promise<OpenedKitDrop[]> {
  const all = ((await tx<(OpenedKitDrop & { owner: string })[]>('inbox', 'readonly', (s) => s.getAll())) ?? []);
  const mine = all.filter((x) => x.owner === me()).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  holdCiphertext(mine.flatMap((x) => x.media ?? []));
  await people.ensure(mine.flatMap((x) => [x.from, ...x.posts.map((p) => p.author_id)])).catch(() => undefined);
  return mine;
}

export async function forgetKitDrop(id: string): Promise<void> {
  const k = (await tx<OpenedKitDrop>('inbox', 'readonly', (s) => s.get(id))) as OpenedKitDrop | undefined;
  await tx('inbox', 'readwrite', (s) => { s.delete(id); });
  releaseCiphertext((k?.media ?? []).map((m) => m.path));
}
