'use client';
// Photos & files (spec §3.11): re-encode on device (drops EXIF/GPS), encrypt in chunks,
// upload ciphertext to the private bucket, decrypt into blob: URLs for display.
import { b64u, decryptFile, encryptFile } from '@kithwall/crypto';
import { useEffect, useState } from 'react';
import { sb, must, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase';
import { netUrl } from './net/runtime';
import { me } from './keys/session';
import type { FileRef, PhotoFiles } from './types';

const BUCKET = 'media';
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const SIZES = { big: 2048, med: 720, thumb: 206 } as const;

async function encode(bitmap: ImageBitmap, maxSide: number): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}

/** Upload an encrypted blob into my folder and register it (unlinked until the owning row exists). */
export async function uploadEncrypted(bytes: Uint8Array, mime: string, link: MediaLink = {}): Promise<FileRef> {
  const path = `${me()}/${crypto.randomUUID()}`;
  const { key, ciphertext } = encryptFile(bytes, path);
  const up = await sb().storage.from(BUCKET).upload(path, new Blob([ciphertext as BlobPart], { type: 'application/octet-stream' }), {
    contentType: 'application/octet-stream', upsert: false,
  });
  if (up.error) throw new Error(up.error.message);
  must(await sb().from('media_objects').insert({ path, owner_id: me(), bytes: ciphertext.byteLength, ...linkCols(link) }));
  return { path, key: b64u.encode(key), mime, bytes: bytes.byteLength };
}

export interface MediaLink { postId?: string; photoId?: string; messageId?: string; profileAvatar?: boolean }
const linkCols = (l: MediaLink) => ({
  post_id: l.postId ?? null, photo_id: l.photoId ?? null, message_id: l.messageId ?? null, profile_avatar: !!l.profileAvatar,
});

/** Link already-uploaded files to the row that grants access to them. */
export async function linkMedia(paths: string[], link: MediaLink) {
  if (!paths.length) return;
  must(await sb().from('media_objects').update(linkCols(link)).in('path', paths));
}

/** Re-encode an image file into the three 2010 sizes, encrypt and upload each. */
export async function uploadPhoto(file: File | Blob, link: MediaLink = {}): Promise<PhotoFiles> {
  if (file.size > MAX_PHOTO_BYTES) throw new Error('Photos must be 20 MB or smaller.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const out = {} as PhotoFiles;
    for (const [name, side] of Object.entries(SIZES) as [keyof PhotoFiles, number][]) {
      const { bytes, w, h } = await encode(bitmap, side);
      out[name] = { ...(await uploadEncrypted(bytes, 'image/jpeg', link)), w, h };
    }
    return out;
  } finally {
    bitmap.close();
  }
}

export const photoPaths = (p: PhotoFiles) => [p.big.path, p.med.path, p.thumb.path];

export async function deleteMedia(paths: string[]) {
  if (!paths.length) return;
  await sb().storage.from(BUCKET).remove(paths);
  await sb().from('media_objects').delete().in('path', paths);
}

// ---------------------------------------------------------------------------------------
// Download + decrypt, cached as object URLs (small LRU so memory stays bounded).
const urls = new Map<string, Promise<string>>();
const MAX_URLS = 400;

export function fileUrl(ref: FileRef): Promise<string> {
  if (ref.parts && ref.parts.length > 1) {
    // Multi-part (large) files are not kept in the shared cache; callers own the URL.
    return downloadFile(ref).then((plain) => URL.createObjectURL(new Blob([plain as BlobPart], { type: ref.mime })));
  }
  const hit = urls.get(ref.path);
  if (hit) { urls.delete(ref.path); urls.set(ref.path, hit); return hit; }
  const p = (async () => {
    const res = await sb().storage.from(BUCKET).download(ref.path);
    if (res.error || !res.data) throw new Error(res.error?.message ?? 'download failed');
    const plain = decryptFile(new Uint8Array(await res.data.arrayBuffer()), b64u.decode(ref.key), ref.path);
    return URL.createObjectURL(new Blob([plain as BlobPart], { type: ref.mime }));
  })();
  p.catch(() => urls.delete(ref.path));
  urls.set(ref.path, p);
  if (urls.size > MAX_URLS) {
    const [oldest, op] = urls.entries().next().value as [string, Promise<string>];
    urls.delete(oldest);
    void op.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
  return p;
}

/** React hook: decrypted object URL for a file reference (null while loading or on failure). */
export function useFileUrl(ref: FileRef | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const path = ref?.path;
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (ref) fileUrl(ref).then((u) => { if (live) setUrl(u); }).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return url;
}


// ---------------------------------------------------------------------------------------
// Large files (videos): encrypted on device in one pass (64 KiB AEAD chunks bound to the file
// id), then the ciphertext is split into parts of at most PART_BYTES, each its own storage object
// and media_objects row. Uploads and downloads report byte progress.

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Each stored part is ≤ 16 MiB (the bucket and media_objects allow 30 MiB per object). */
export const PART_BYTES = 16 * 1024 * 1024;

export type ProgressFn = (loaded: number, total: number) => void;

/** All storage paths that make up a file (one for ordinary files). */
export const fileRefPaths = (ref: FileRef): string[] => (ref.parts?.length ? ref.parts : [ref.path]);

/** Size of the stored ciphertext for a plaintext of `bytes` (see packages/crypto files.ts). */
export function cipherSize(bytes: number): number {
  return 17 + bytes + Math.max(1, Math.ceil(bytes / 65536)) * 16;
}

async function accessToken(): Promise<string> {
  const { data } = await sb().auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error('Please sign in again.');
  return t;
}

const objectUrl = (path: string) => netUrl(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`);

function putObject(path: string, body: Blob, token: string, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', objectUrl(path));
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_PUBLISHABLE_KEY);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(body.size); resolve(); return; }
      let msg = `Upload failed (${xhr.status}).`;
      try { msg = (JSON.parse(xhr.responseText) as { message?: string }).message || msg; } catch { /* keep */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * Encrypt a large file on this device and upload it in parts. Returns a FileRef whose `parts`
 * lists every object in order. On failure, already-uploaded parts are deleted.
 */
export async function uploadLargeEncrypted(bytes: Uint8Array, mime: string,
  opts: { link?: MediaLink; onProgress?: ProgressFn; signal?: AbortSignal } = {}): Promise<FileRef> {
  const owner = me();
  const first = `${owner}/${crypto.randomUUID()}`;
  // Let the UI paint "Encrypting…" before the synchronous encryption pass.
  await new Promise((r) => setTimeout(r, 0));
  const { key, ciphertext } = encryptFile(bytes, first);
  const n = Math.max(1, Math.ceil(ciphertext.byteLength / PART_BYTES));
  const paths = [first, ...Array.from({ length: n - 1 }, () => `${owner}/${crypto.randomUUID()}`)];
  const total = ciphertext.byteLength;
  const token = await accessToken();
  const done: string[] = [];
  let sent = 0;
  try {
    for (let i = 0; i < n; i++) {
      if (opts.signal?.aborted) throw new DOMException('Upload cancelled.', 'AbortError');
      const part = ciphertext.subarray(i * PART_BYTES, Math.min(total, (i + 1) * PART_BYTES));
      // Register first so a failed upload can always be cleaned up by path.
      must(await sb().from('media_objects').insert({ path: paths[i], owner_id: owner, bytes: part.byteLength, ...linkCols(opts.link ?? {}) }));
      done.push(paths[i]!);
      await putObject(paths[i]!, new Blob([part as BlobPart], { type: 'application/octet-stream' }), token,
        (loaded) => opts.onProgress?.(sent + loaded, total), opts.signal);
      sent += part.byteLength;
    }
  } catch (e) {
    await deleteMedia(done).catch(() => undefined);
    throw e;
  }
  const keyB64 = b64u.encode(key);
  key.fill(0);
  return { path: first, key: keyB64, mime, bytes: bytes.byteLength, ...(n > 1 ? { parts: paths } : {}) };
}

/** Download every part of a file (with progress), verify and decrypt it on this device. */
export async function downloadFile(ref: FileRef, opts: { onProgress?: ProgressFn; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  // The FileRef comes from a decrypted payload: check its shape before fetching anything.
  const paths = fileRefPaths(ref);
  if (!Array.isArray(paths) || paths.length > 64 || paths[0] !== ref.path
    || !paths.every((p) => typeof p === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}(-[a-z0-9]+)?$/.test(p))
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 512 * 1024 * 1024) {
    throw new Error('This file couldn’t be verified.');
  }
  const token = await accessToken();
  const expected = cipherSize(ref.bytes);
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (const path of paths) {
    const res = await fetch(netUrl(`${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`), {
      headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: opts.signal,
    });
    if (!res.ok || !res.body) throw new Error(res.status === 404 || res.status === 400 ? 'This video is no longer available.' : 'Download failed. Please try again.');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      if (got > expected + 1024) throw new Error('This file couldn’t be verified.');
      opts.onProgress?.(got, Math.max(expected, got));
    }
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  chunks.length = 0;
  await new Promise((r) => setTimeout(r, 0));
  try {
    return decryptFile(all, b64u.decode(ref.key), ref.path);
  } catch {
    throw new Error('This file couldn’t be verified.');
  }
}
