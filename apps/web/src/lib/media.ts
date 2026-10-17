'use client';
// Photos & files (spec §3.11): re-encode on device (drops EXIF/GPS), encrypt in chunks,
// upload ciphertext to the private bucket, decrypt into blob: URLs for display.
import { b64u, decryptFile, encryptFile } from '@kithwall/crypto';
import { useEffect, useState } from 'react';
import { sb, must } from './supabase';
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
