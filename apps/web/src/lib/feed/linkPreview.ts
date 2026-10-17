'use client';
// Link previews (spec §1, scope "Link previews"): the URL is fetched by our no-log proxy so
// friends' IP addresses never reach the linked site. The preview (title, description, image)
// is then encrypted on this device with the post; the image is re-encoded and uploaded as an
// encrypted file, like a photo.
import { sb } from '../supabase';
import { uploadEncrypted } from '../media';
import type { FileRef, PostPayload } from '../types';

export interface LinkPreviewResult {
  url: string; title?: string; description?: string; site?: string;
  image?: { mime: string; data: string } | null;
}

export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

export async function fetchLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreviewResult> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const res = await fetch('/api/link-preview', {
    method: 'POST', signal, cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url }),
  });
  const body = await res.json().catch(() => ({})) as LinkPreviewResult & { error?: string };
  if (!res.ok) throw new Error(body.error || 'Couldn\'t load a preview for that link.');
  return body;
}

const THUMB = 240;

/** Re-encode the preview image on device (drops metadata, bounds size), encrypt and upload it. */
export async function uploadPreviewImage(img: { mime: string; data: string }): Promise<FileRef | undefined> {
  if (!/^image\/(jpeg|png|gif|webp)$/.test(img.mime)) return undefined;
  const bin = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bin], { type: img.mime }));
  try {
    const scale = Math.min(1, THUMB / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const ref = await uploadEncrypted(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg');
    return { ...ref, w, h };
  } finally {
    bitmap.close();
  }
}

export function toPayloadLink(p: LinkPreviewResult, image?: FileRef): NonNullable<PostPayload['link']> {
  return {
    url: p.url,
    title: p.title?.slice(0, 200) || undefined,
    description: p.description?.slice(0, 400) || undefined,
    site: p.site?.slice(0, 100) || undefined,
    image,
  };
}
