'use client';
// Albums and photos: each photo row has its own envelope (caption, file keys, tags) under the
// album's audience. Comments on photos use the photo's content key (see content.ts addComment).
import { b64u, extractContentKey, openEnvelope, sealEnvelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people } from './people';
import { linkMedia, photoPaths, uploadPhoto, deleteMedia } from './media';
import type { Decrypted } from './content';
import type { PhotoFiles } from './types';

export interface AlbumRow { id: string; owner_id: string; is_public: boolean; audience_id: string | null; epoch: number | null; envelope: never; created_at: string; updated_at: string }
export interface PhotoRow { id: string; album_id: string; owner_id: string; position: number; is_public: boolean; audience_id: string | null; epoch: number | null; envelope: never; created_at: string }
export interface AlbumPayload { name: string; description?: string; location?: string; kind?: 'normal' | 'wall' | 'profile' | 'mobile' }
export interface PhotoPayload { files: PhotoFiles; caption?: string; tags: { id: string; x: number; y: number }[]; takenAt?: string }

export type AlbumAudience = { kind: 'friends' } | { kind: 'self' } | { kind: 'audience'; id: string } | { kind: 'public' };

const albumHeader = (a: Pick<AlbumRow, 'id' | 'owner_id' | 'is_public' | 'audience_id' | 'epoch'>): EnvelopeHeader =>
  ({ v: 1, type: 'album', id: a.id, author: a.owner_id, audience: a.is_public ? 'public' : { id: a.audience_id!, epoch: a.epoch! } });
export const photoHeader = (p: Pick<PhotoRow, 'id' | 'album_id' | 'owner_id' | 'is_public' | 'audience_id' | 'epoch'>): EnvelopeHeader =>
  ({ v: 1, type: 'photo', id: p.id, author: p.owner_id, wall: p.album_id, audience: p.is_public ? 'public' : { id: p.audience_id!, epoch: p.epoch! } });

async function audienceFor(a: AlbumAudience) {
  if (a.kind === 'public') return { audience_id: null, epoch: null, key: undefined as Uint8Array | undefined, is_public: true };
  const id = a.kind === 'friends' ? keyring.friendsAudience!.id : a.kind === 'self' ? keyring.selfAudience!.id : a.id;
  const { key, epoch } = await keyring.current(id);
  return { audience_id: id, epoch, key, is_public: false };
}

export async function createAlbum(payload: AlbumPayload, audience: AlbumAudience = { kind: 'friends' }): Promise<AlbumRow> {
  const id = crypto.randomUUID();
  const a = await audienceFor(audience);
  const row = { id, owner_id: me(), is_public: a.is_public, audience_id: a.audience_id, epoch: a.epoch };
  const envelope = sealEnvelope({ header: albumHeader(row), payload, audienceKey: a.key, signPriv: identity().signPriv });
  return must(await sb().from('albums').insert({ ...row, envelope }).select().single()) as AlbumRow;
}

/** The special per-user albums ("Wall Photos", "Profile Pictures"), created on first use. */
export async function systemAlbum(kind: 'wall' | 'profile' | 'mobile'): Promise<AlbumRow> {
  const mine = must(await sb().from('albums').select('*').eq('owner_id', me())) as AlbumRow[];
  for (const a of mine) {
    const r = readAlbum(a);
    if (r.ok && r.value.kind === kind) return a;
  }
  const names = { wall: 'Wall Photos', profile: 'Profile Pictures', mobile: 'Mobile Uploads' };
  return createAlbum({ name: names[kind], kind });
}

export function readAlbum(row: AlbumRow): Decrypted<AlbumPayload> {
  const owner = people.get(row.owner_id);
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!);
  if (!owner || (!row.is_public && !key)) return { ok: false, reason: 'waiting' };
  try { return { ok: true, value: openEnvelope<AlbumPayload>({ header: albumHeader(row), envelope: row.envelope, audienceKey: key ?? undefined, signPub: b64u.decode(owner.sign_pub) }) }; }
  catch { return { ok: false, reason: 'unverified' }; }
}

export async function updateAlbum(row: AlbumRow, payload: AlbumPayload) {
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!) ?? undefined;
  const envelope = sealEnvelope({ header: albumHeader(row), payload, audienceKey: key, signPriv: identity().signPriv });
  must(await sb().from('albums').update({ envelope, updated_at: new Date().toISOString() }).eq('id', row.id));
}

/** Upload image files into an album. Returns the new photo rows (in order). */
export async function addPhotos(album: AlbumRow, files: (File | Blob)[], captions: string[] = [], onProgress?: (done: number) => void): Promise<{ row: PhotoRow; payload: PhotoPayload }[]> {
  const key = album.is_public ? undefined : keyring.get(album.audience_id!, album.epoch!) ?? undefined;
  if (!album.is_public && !key) throw new Error('Missing album key');
  const existing = must(await sb().from('photos').select('position').eq('album_id', album.id).order('position', { ascending: false }).limit(1)) as { position: number }[];
  let pos = (existing[0]?.position ?? -1) + 1;
  const out: { row: PhotoRow; payload: PhotoPayload }[] = [];
  for (let i = 0; i < files.length; i++) {
    const filesUp = await uploadPhoto(files[i]!);
    const base = { id: crypto.randomUUID(), album_id: album.id, owner_id: me(), position: pos++, is_public: album.is_public, audience_id: album.audience_id, epoch: album.epoch };
    const payload: PhotoPayload = { files: filesUp, caption: captions[i] || undefined, tags: [] };
    const envelope = sealEnvelope({ header: photoHeader(base), payload, audienceKey: key, signPriv: identity().signPriv });
    const row = must(await sb().from('photos').insert({ ...base, envelope }).select().single()) as PhotoRow;
    await linkMedia(photoPaths(filesUp), { photoId: row.id });
    out.push({ row, payload });
    onProgress?.(i + 1);
  }
  return out;
}

export function readPhoto(row: PhotoRow): Decrypted<PhotoPayload> {
  const owner = people.get(row.owner_id);
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!);
  if (!owner || (!row.is_public && !key)) return { ok: false, reason: 'waiting' };
  try { return { ok: true, value: openEnvelope<PhotoPayload>({ header: photoHeader(row), envelope: row.envelope, audienceKey: key ?? undefined, signPub: b64u.decode(owner.sign_pub) }) }; }
  catch { return { ok: false, reason: 'unverified' }; }
}

/** Content key for photo comments (null for public photos). */
export function photoContentKey(row: PhotoRow): Uint8Array | null {
  if (row.is_public) return null;
  const key = keyring.get(row.audience_id!, row.epoch!);
  const owner = people.get(row.owner_id);
  if (!key || !owner) return null;
  try {
    return extractContentKey({ header: photoHeader(row), envelope: row.envelope, audienceKey: key, signPub: b64u.decode(owner.sign_pub) });
  } catch { return null; }
}

/** Owner re-signs the photo with updated caption/tags. Tagged friends get a tag notice + notification. */
export async function updatePhoto(row: PhotoRow, payload: PhotoPayload) {
  if (row.owner_id !== me()) throw new Error('Only the owner can edit this photo');
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!) ?? undefined;
  const envelope = sealEnvelope({ header: photoHeader(row), payload, audienceKey: key, signPriv: identity().signPriv });
  must(await sb().from('photos').update({ envelope }).eq('id', row.id));
}

export async function tagFriend(row: PhotoRow, payload: PhotoPayload, friendId: string, x: number, y: number) {
  if (payload.tags.some((t) => t.id === friendId)) return payload;
  const next = { ...payload, tags: [...payload.tags, { id: friendId, x, y }] };
  await updatePhoto(row, next);
  if (friendId !== me()) {
    await sb().from('tag_notices').insert({ photo_id: row.id, tagged_id: friendId, tagger_id: me() });
    await sb().from('notifications').insert({ recipient_id: friendId, actor_id: me(), type: 'tag', object_kind: 'photo', object_id: row.id });
  }
  return next;
}

export async function removeTag(row: PhotoRow, payload: PhotoPayload, friendId: string) {
  const next = { ...payload, tags: payload.tags.filter((t) => t.id !== friendId) };
  if (row.owner_id === me()) await updatePhoto(row, next);
  await sb().from('tag_notices').update({ status: 'removed' }).match({ photo_id: row.id, tagged_id: friendId });
  return next;
}

export async function deletePhoto(row: PhotoRow, payload?: PhotoPayload) {
  must(await sb().from('photos').delete().eq('id', row.id));
  if (payload) await deleteMedia(photoPaths(payload.files));
}

/** Photos tagged with a user that I can see (via approved/pending tag notices I can read, or my own). */
export async function taggedPhotos(userId: string, limit = 20): Promise<PhotoRow[]> {
  const notices = must(await sb().from('tag_notices').select('photo_id').eq('tagged_id', userId).neq('status', 'removed').order('created_at', { ascending: false }).limit(limit)) as { photo_id: string }[];
  if (!notices.length) return [];
  const rows = must(await sb().from('photos').select('*').in('id', notices.map((n) => n.photo_id))) as PhotoRow[];
  await people.ensure(rows.map((r) => r.owner_id));
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Set my profile picture: upload into "Profile Pictures" and mark files readable by friends. */
export async function setProfilePicture(file: File | Blob): Promise<PhotoFiles> {
  const album = await systemAlbum('profile');
  const [p] = await addPhotos(album, [file]);
  const files = p!.payload.files;
  await linkMedia(photoPaths(files), { photoId: p!.row.id, profileAvatar: true });
  return files;
}
