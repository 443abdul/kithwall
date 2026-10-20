'use client';
// Albums data layer (Kithwall 2), built on the v1 photo E2EE code (lib/photos.ts, lib/media.ts):
// every photo row has its own envelope (caption, tags, file keys) under the album's audience; files are
// re-encoded on device (EXIF/GPS dropped), encrypted, then uploaded. New in v2: videos in albums
// (encrypted in parts, ≤ 100 MB, with a poster frame) and albums shared with a circle (migration
// 20261022000100_circles.sql lets album/photo rows use a circle's audience).
import { sealEnvelope } from '@kithwall/crypto';
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { identity, me, useSession } from '@/lib/keys/session';
import { keyring } from '@/lib/keys/keyring';
import { useKeyringVersion } from '@/lib/hooks';
import { addComment, readComment, type Decrypted } from '@/lib/content';
import { people } from '@/lib/people';
import {
  addPhotos, albumPhotos, createAlbum, deleteAlbum, deletePhoto, downloadPhoto, getAlbum, listAlbums,
  notifyPhotoOwner, photoContentKey, photoHeader, readAlbum, readPhoto, removeTag, tagFriend, updateAlbum, updatePhoto,
  type AlbumAudience, type AlbumPayload, type AlbumRow, type PhotoPayload, type PhotoRow,
} from '@/lib/photos';
import {
  deleteMedia, downloadFile, fileRefPaths, linkMedia, MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, photoPaths, uploadLargeEncrypted, uploadPhoto,
} from '@/lib/media';
import type { CommentRow, FileRef } from '@/lib/types';
import type { ShareAudience } from '@/components/circles/shared';
import type { CircleRow } from '@/components/circles/data';

export type { AlbumRow, PhotoRow, AlbumPayload };

/** v1 PhotoPayload + an optional video (the photo files are then its poster frame). */
export interface MediaPayload extends PhotoPayload {
  video?: { file: FileRef; duration?: number; w?: number; h?: number };
}

export { readAlbum, updateAlbum, deleteAlbum, deletePhoto, getAlbum, tagFriend, removeTag, updatePhoto, photoContentKey };

export function readMedia(row: PhotoRow): Decrypted<MediaPayload> {
  return readPhoto(row) as Decrypted<MediaPayload>;
}

/** Map a picker choice to a v1 album audience. */
export function toAlbumAudience(a: ShareAudience, circles: { id: string; audienceId: string }[]): AlbumAudience {
  if (a.kind === 'only_me') return { kind: 'self' };
  if (a.kind === 'circle') {
    const c = circles.find((x) => x.id === a.circleId);
    if (!c) throw new Error('circle');
    return { kind: 'audience', id: c.audienceId };
  }
  return { kind: 'friends' };
}

export type AudienceKind = { kind: 'connections' } | { kind: 'only_me' } | { kind: 'circle'; audienceId: string } | { kind: 'other' };

export function albumAudienceKind(row: Pick<AlbumRow, 'audience_id' | 'owner_id' | 'is_public'>): AudienceKind {
  if (row.is_public) return { kind: 'other' };
  if (row.owner_id === me()) {
    if (row.audience_id === keyring.friendsAudience?.id) return { kind: 'connections' };
    if (row.audience_id === keyring.selfAudience?.id) return { kind: 'only_me' };
  }
  return row.audience_id ? { kind: 'circle', audienceId: row.audience_id } : { kind: 'other' };
}

export async function newAlbum(payload: AlbumPayload, audience: AlbumAudience) {
  const clean: AlbumPayload = { name: payload.name.trim().slice(0, 120) };
  const description = payload.description?.trim().slice(0, 2000);
  if (description) clean.description = description;
  return createAlbum(clean, audience);
}

export async function circleAlbums(c: CircleRow): Promise<AlbumRow[]> {
  const rows = must(await sb().from('albums').select('*').eq('audience_id', c.audience_id).order('updated_at', { ascending: false }).limit(100)) as AlbumRow[];
  await people.ensure(rows.map((r) => r.owner_id));
  return rows;
}

// ---------------------------------------------------------------------------------------
// Uploads

export type UploadKind = 'photo' | 'video';
export function uploadKind(f: Pick<File, 'type' | 'name'>): UploadKind | null {
  if (f.type.startsWith('image/')) return 'photo';
  if (f.type.startsWith('video/')) return 'video';
  if (/\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(f.name)) return 'photo';
  if (/\.(mp4|m4v|mov|webm)$/i.test(f.name)) return 'video';
  return null;
}

export function checkUpload(f: Pick<File, 'type' | 'name' | 'size'>): 'type' | 'photoSize' | 'videoSize' | null {
  const k = uploadKind(f);
  if (!k) return 'type';
  if (k === 'photo' && f.size > MAX_PHOTO_BYTES) return 'photoSize';
  if (k === 'video' && f.size > MAX_VIDEO_BYTES) return 'videoSize';
  return null;
}

/** A poster frame for a video, captured on this device (falls back to a plain frame). */
async function videoPoster(file: File): Promise<{ blob: Blob; duration?: number; w?: number; h?: number }> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout')), 10_000);
      v.onloadeddata = () => { clearTimeout(to); resolve(); };
      v.onerror = () => { clearTimeout(to); reject(new Error('decode')); };
    });
    const duration = Number.isFinite(v.duration) ? v.duration : undefined;
    await new Promise<void>((resolve) => {
      const to = setTimeout(resolve, 3000);
      v.onseeked = () => { clearTimeout(to); resolve(); };
      v.currentTime = Math.min(0.5, (duration ?? 1) / 2);
    });
    const w = v.videoWidth || 640, h = v.videoHeight || 360;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')?.drawImage(v, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('poster'))), 'image/jpeg', 0.85));
    return { blob, duration, w, h };
  } catch {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.fillStyle = '#444'; ctx.fillRect(0, 0, 640, 360); }
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('poster'))), 'image/jpeg', 0.8));
    return { blob };
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}

function albumKey(album: AlbumRow): Uint8Array | undefined {
  if (album.is_public) return undefined;
  const key = keyring.get(album.audience_id!, album.epoch!);
  if (!key) throw new Error('Missing album key');
  return key;
}

/** Encrypt and upload one video into an album. `onProgress` gets 0..1. */
export async function addVideo(album: AlbumRow, file: File, caption: string | undefined, onProgress: (f: number) => void, signal?: AbortSignal): Promise<PhotoRow> {
  if (album.owner_id !== me()) throw new Error('owner');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('videoSize');
  const key = albumKey(album);
  onProgress(0.01);
  const poster = await videoPoster(file);
  const files = await uploadPhoto(poster.blob);
  onProgress(0.05);
  let ref: FileRef | null = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    ref = await uploadLargeEncrypted(bytes, file.type || 'video/mp4', { signal, onProgress: (l, t) => onProgress(0.05 + 0.93 * (t ? l / t : 0)) });
    const existing = must(await sb().from('photos').select('position').eq('album_id', album.id).order('position', { ascending: false }).limit(1)) as { position: number }[];
    const base = { id: crypto.randomUUID(), album_id: album.id, owner_id: me(), position: (existing[0]?.position ?? -1) + 1, is_public: album.is_public, audience_id: album.audience_id, epoch: album.epoch };
    const c = caption?.trim().slice(0, 2000);
    const video: MediaPayload['video'] = { file: ref };
    if (poster.duration) video.duration = Math.round(poster.duration);
    if (poster.w) video.w = poster.w;
    if (poster.h) video.h = poster.h;
    const payload: MediaPayload = { files, tags: [], video, ...(c ? { caption: c } : {}) };
    const envelope = sealEnvelope({ header: photoHeader(base), payload, audienceKey: key, signPriv: identity().signPriv });
    const row = must(await sb().from('photos').insert({ ...base, envelope }).select().single()) as PhotoRow;
    await linkMedia([...photoPaths(files), ...fileRefPaths(ref)], { photoId: row.id });
    onProgress(1);
    return row;
  } catch (e) {
    await deleteMedia([...photoPaths(files), ...(ref ? fileRefPaths(ref) : [])]).catch(() => undefined);
    throw e;
  }
}

export async function addPhoto(album: AlbumRow, file: File, caption?: string): Promise<PhotoRow> {
  const [p] = await addPhotos(album, [file], caption ? [caption] : []);
  return p!.row;
}

/** Save the decrypted original (largest stored size for photos; the video file for videos). */
export async function downloadOriginal(p: MediaPayload, name: string) {
  if (!p.video) { await downloadPhoto(p.files, name); return; }
  const bytes = await downloadFile(p.video.file);
  const ext = (p.video.file.mime.split('/')[1] ?? 'mp4').replace('quicktime', 'mov');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: p.video.file.mime }));
  const a = document.createElement('a');
  a.href = url; a.download = `${name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video'}.${ext}`; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function removeMedia(row: PhotoRow, p: MediaPayload | undefined) {
  if (p?.video) await deleteMedia(fileRefPaths(p.video.file)).catch(() => undefined);
  await deletePhoto(row, p);
}

// ---------------------------------------------------------------------------------------
// Comments on a photo (sealed under a key derived from the photo's content key)

export async function photoComments(photoId: string): Promise<CommentRow[]> {
  const rows = must(await sb().from('comments').select('*').eq('photo_id', photoId).order('created_at', { ascending: true }).limit(500)) as CommentRow[];
  await people.ensure(rows.map((r) => r.author_id));
  return rows;
}

export async function commentOnPhoto(row: PhotoRow, text: string) {
  const c = await addComment({ photoId: row.id, contentKey: photoContentKey(row) }, text.trim().slice(0, 8000));
  await notifyPhotoOwner(row, 'comment', text);
  return c;
}

export function readPhotoComment(c: CommentRow, row: PhotoRow) {
  return readComment(c, photoContentKey(row));
}

export async function deleteComment(c: CommentRow) {
  must(await sb().from('comments').delete().eq('id', c.id));
}

// ---------------------------------------------------------------------------------------
// Hooks

function useReady() { return useSession().status === 'ready'; }

export function useAlbumsList(which: 'mine' | 'shared') {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({
    queryKey: ['albums', which], enabled: ready,
    queryFn: () => (which === 'mine' ? listAlbums({ ownerId: me(), limit: 200 }) : listAlbums({ excludeOwner: me(), limit: 200 })),
  });
}

export function useCircleAlbums(c: CircleRow) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['albums', 'circle', c.audience_id], enabled: ready, queryFn: () => circleAlbums(c) });
}

export function useAlbum(id: string) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['albums', 'one', id], enabled: ready, queryFn: () => getAlbum(id) });
}

export function useAlbumMedia(id: string, enabled = true) {
  const ready = useReady();
  useKeyringVersion();
  return useQuery({ queryKey: ['albums', 'media', id], enabled: ready && enabled, queryFn: () => albumPhotos(id) });
}

export function useAlbumCover(album: AlbumRow) {
  const ready = useReady();
  return useQuery({
    queryKey: ['albums', 'cover', album.id, album.updated_at], enabled: ready,
    queryFn: async () => {
      const first = must(await sb().from('photos').select('*').eq('album_id', album.id).order('position').limit(1)) as PhotoRow[];
      const { count } = await sb().from('photos').select('id', { count: 'exact', head: true }).eq('album_id', album.id);
      return { cover: first[0] ?? null, count: count ?? 0 };
    },
  });
}

export function usePhotoComments(photoId: string | null) {
  const ready = useReady();
  return useQuery({ queryKey: ['comments', photoId], enabled: ready && !!photoId, queryFn: () => photoComments(photoId!) });
}
