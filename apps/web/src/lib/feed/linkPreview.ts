'use client';
// Link previews (spec §1, scope "Link previews"): the URL is fetched by our no-log proxy so
// friends' IP addresses never reach the linked site. The preview (title, description, image)
// is then encrypted on this device with the post; the image is re-encoded and uploaded as an
// encrypted file, like a photo.
import { sb } from '../supabase';
import { uploadEncrypted } from '../media';
import { validEmbed, type Embed } from '../embeds';
import type { FileRef, PostPayload } from '../types';

export interface LinkPreviewResult {
  url: string; title?: string; description?: string; site?: string;
  image?: { mime: string; data: string } | null;
  embed?: Embed | null;
}

/** A preview that is ready to attach: image already downscaled + re-encoded on this device. */
export interface LinkDraft {
  preview: LinkPreviewResult;
  image?: PreparedImage;
  embed?: Embed;
}

export interface PreparedImage { blob: Blob; w: number; h: number }

/** Largest side of an attached preview image (wide cards); square thumbnails are kept smaller. */
export const PREVIEW_MAX = 1200;
const THUMB_MAX = 400;
/** A preview image is shown as a wide card when it is landscape and at least this wide. */
export const WIDE_MIN = 400;
export const isWide = (w?: number, h?: number) => !!w && !!h && w >= WIDE_MIN && w > h * 1.15;

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

/**
 * Decode the proxy's image on this device, downscale it (≤ 1200 px for wide cards, ≤ 400 px for
 * thumbnails) and re-encode it as JPEG through a canvas, which drops all metadata.
 */
export async function prepareImage(img: { mime: string; data: string }, forceWide = false): Promise<PreparedImage | undefined> {
  if (!/^image\/(jpeg|png|gif|webp)$/.test(img.mime)) return undefined;
  const bin = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bin], { type: img.mime }));
  try {
    const max = forceWide || isWide(bitmap.width, bitmap.height) ? PREVIEW_MAX : THUMB_MAX;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.84 });
    return { blob, w, h };
  } finally {
    bitmap.close();
  }
}

/** Encrypt and upload a prepared preview image (unlinked until the post exists). */
export async function uploadPreparedImage(p: PreparedImage): Promise<FileRef> {
  const ref = await uploadEncrypted(new Uint8Array(await p.blob.arrayBuffer()), 'image/jpeg');
  return { ...ref, w: p.w, h: p.h };
}


/** Fetch a preview and prepare it for attaching (image re-encoded, embed validated). */
export async function loadLinkDraft(url: string, signal?: AbortSignal): Promise<LinkDraft> {
  const preview = await fetchLinkPreview(url, signal);
  const embed = validEmbed(preview.embed) ?? undefined;
  const image = preview.image ? await prepareImage(preview.image, !!embed).catch(() => undefined) : undefined;
  return { preview: { ...preview, image: null, embed }, image, embed };
}

export function toPayloadLink(p: LinkPreviewResult, image?: FileRef, embed?: Embed | null): NonNullable<PostPayload['link']> {
  const e = validEmbed(embed ?? p.embed);
  return {
    url: p.url,
    title: p.title?.slice(0, 200) || undefined,
    description: p.description?.slice(0, 400) || undefined,
    site: p.site?.slice(0, 100) || undefined,
    image,
    ...(e ? { embed: e } : {}),
  };
}
