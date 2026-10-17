'use client';
// Albums and photos: each photo row has its own envelope (caption, file keys, tags) under the
// album's audience (or its own audience). Comments on photos use the photo's content key (see
// content.ts addComment).
import { b64u, decryptBlob, decryptFile, deriveVaultKey, extractContentKey, openEnvelope, sealEnvelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { amk, getSession, identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people } from './people';
import { linkMedia, photoPaths, uploadPhoto, deleteMedia } from './media';
import { myInfo, notify, saveProfileInfo } from './friends';
import type { Decrypted } from './content';
import type { AudienceRow, FileRef, PhotoFiles } from './types';

export interface AlbumRow { id: string; owner_id: string; is_public: boolean; audience_id: string | null; epoch: number | null; envelope: never; created_at: string; updated_at: string }
export interface PhotoRow { id: string; album_id: string; owner_id: string; position: number; is_public: boolean; audience_id: string | null; epoch: number | null; envelope: never; created_at: string }
export interface AlbumPayload { name: string; description?: string; location?: string; kind?: 'normal' | 'wall' | 'profile' | 'mobile'; coverId?: string }
export interface PhotoPayload { files: PhotoFiles; caption?: string; tags: { id: string; x: number; y: number }[]; takenAt?: string }
export interface TagNotice { photo_id: string; tagged_id: string; tagger_id: string; status: 'pending' | 'approved' | 'removed'; created_at: string }

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

/** The audience an existing row uses, as an AlbumAudience. */
export function rowAudience(row: Pick<AlbumRow, 'is_public' | 'audience_id'>): AlbumAudience {
  if (row.is_public) return { kind: 'public' };
  if (row.audience_id === keyring.friendsAudience?.id) return { kind: 'friends' };
  if (row.audience_id === keyring.selfAudience?.id) return { kind: 'self' };
  return { kind: 'audience', id: row.audience_id! };
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

/**
 * Upload image files into an album. Returns the new photo rows (in order).
 * `audience` defaults to the album's audience (e.g. a wall photo posted to "Only Me").
 */
export async function addPhotos(
  album: AlbumRow, files: (File | Blob)[], captions: string[] = [], onProgress?: (done: number) => void,
  audience?: AlbumAudience,
): Promise<{ row: PhotoRow; payload: PhotoPayload }[]> {
  if (album.owner_id !== me()) throw new Error('You can only add photos to your own albums.');
  let aud: { is_public: boolean; audience_id: string | null; epoch: number | null; key: Uint8Array | undefined };
  if (audience) aud = await audienceFor(audience);
  else {
    const key = album.is_public ? undefined : keyring.get(album.audience_id!, album.epoch!) ?? undefined;
    if (!album.is_public && !key) throw new Error('Missing album key');
    aud = { is_public: album.is_public, audience_id: album.audience_id, epoch: album.epoch, key };
  }
  const existing = must(await sb().from('photos').select('position').eq('album_id', album.id).order('position', { ascending: false }).limit(1)) as { position: number }[];
  let pos = (existing[0]?.position ?? -1) + 1;
  const out: { row: PhotoRow; payload: PhotoPayload }[] = [];
  for (let i = 0; i < files.length; i++) {
    const filesUp = await uploadPhoto(files[i]!);
    const base = { id: crypto.randomUUID(), album_id: album.id, owner_id: me(), position: pos++, is_public: aud.is_public, audience_id: aud.audience_id, epoch: aud.epoch };
    const caption = captions[i]?.trim().slice(0, 2000);
    // canonicalJson rejects undefined values, so optional fields are omitted rather than undefined.
    const payload: PhotoPayload = { files: filesUp, tags: [], ...(caption ? { caption } : {}) };
    let row: PhotoRow;
    try {
      const envelope = sealEnvelope({ header: photoHeader(base), payload, audienceKey: aud.key, signPriv: identity().signPriv });
      row = must(await sb().from('photos').insert({ ...base, envelope }).select().single()) as PhotoRow;
    } catch (e) {
      await deleteMedia(photoPaths(filesUp)).catch(() => undefined); // don't leave orphaned ciphertext
      throw e;
    }
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
  return key ? extractContentKey({ header: photoHeader(row), envelope: row.envelope, audienceKey: key }) : null;
}

/** Owner re-signs the photo with updated caption/tags. */
export async function updatePhoto(row: PhotoRow, payload: PhotoPayload) {
  if (row.owner_id !== me()) throw new Error('Only the owner can edit this photo');
  const key = row.is_public ? undefined : keyring.get(row.audience_id!, row.epoch!) ?? undefined;
  const envelope = sealEnvelope({ header: photoHeader(row), payload, audienceKey: key, signPriv: identity().signPriv });
  must(await sb().from('photos').update({ envelope }).eq('id', row.id));
}

/** Tag a friend (or myself). The tag lives in the encrypted payload; a tag notice lets the person find/approve it. */
export async function tagFriend(row: PhotoRow, payload: PhotoPayload, friendId: string, x: number, y: number) {
  if (payload.tags.some((t) => t.id === friendId)) return payload;
  const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
  const next = { ...payload, tags: [...payload.tags, { id: friendId, x: clamp(x), y: clamp(y) }] };
  await updatePhoto(row, next);
  const self = friendId === me();
  const ins = await sb().from('tag_notices').insert({ photo_id: row.id, tagged_id: friendId, tagger_id: me() });
  if (ins.error && ins.error.code !== '23505') throw new Error(ins.error.message);
  if (self || ins.error) {
    // My own tag is approved right away; re-tagging someone who removed a tag asks them again.
    await sb().from('tag_notices').update({ status: self ? 'approved' : 'pending' }).match({ photo_id: row.id, tagged_id: friendId });
  }
  if (!self) await notify(friendId, 'tag', 'photo', row.id).catch(() => undefined);
  return next;
}

export async function removeTag(row: PhotoRow, payload: PhotoPayload, friendId: string) {
  const next = { ...payload, tags: payload.tags.filter((t) => t.id !== friendId) };
  if (row.owner_id === me()) await updatePhoto(row, next);
  await sb().from('tag_notices').update({ status: 'removed' }).match({ photo_id: row.id, tagged_id: friendId });
  return next;
}

/** The tagged person approves a pending tag. */
export async function approveTag(photoId: string) {
  must(await sb().from('tag_notices').update({ status: 'approved' }).match({ photo_id: photoId, tagged_id: me() }));
}

export async function tagNotices(photoId: string): Promise<TagNotice[]> {
  return must(await sb().from('tag_notices').select('*').eq('photo_id', photoId)) as TagNotice[];
}

/** Tags waiting for my approval (newest first). */
export async function myPendingTags(limit = 50): Promise<TagNotice[]> {
  return must(await sb().from('tag_notices').select('*').eq('tagged_id', me()).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(limit)) as TagNotice[];
}

/** Tags that should be shown: in the signed payload and not removed by the tagged person. */
export function visibleTags(payload: PhotoPayload, notices: TagNotice[]) {
  const removed = new Set(notices.filter((n) => n.status === 'removed').map((n) => n.tagged_id));
  return payload.tags.filter((t) => !removed.has(t.id));
}

export async function deletePhoto(row: PhotoRow, payload?: PhotoPayload) {
  // Files first: the storage delete policy needs the media_objects link (which the photo row's
  // cascade would remove), so deleting the row first would leave orphaned ciphertext behind.
  const linked = must(await sb().from('media_objects').select('path').eq('photo_id', row.id)) as { path: string }[];
  const paths = new Set(linked.map((m) => m.path));
  if (payload) photoPaths(payload.files).forEach((p) => paths.add(p));
  await deleteMedia([...paths]);
  must(await sb().from('photos').delete().eq('id', row.id));
}

/** Delete an album, all its photos (rows cascade) and all their encrypted files. */
export async function deleteAlbum(album: AlbumRow, onProgress?: (msg: string) => void) {
  if (album.owner_id !== me()) throw new Error('Only the owner can delete this album');
  const photos = must(await sb().from('photos').select('id').eq('album_id', album.id)) as { id: string }[];
  const paths: string[] = [];
  for (let i = 0; i < photos.length; i += 100) {
    const ids = photos.slice(i, i + 100).map((p) => p.id);
    const rows = must(await sb().from('media_objects').select('path').in('photo_id', ids)) as { path: string }[];
    paths.push(...rows.map((r) => r.path));
  }
  for (let i = 0; i < paths.length; i += 100) {
    onProgress?.(`Removing files ${Math.min(i + 100, paths.length)} of ${paths.length}…`);
    await deleteMedia(paths.slice(i, i + 100));
  }
  onProgress?.('Deleting album…');
  must(await sb().from('albums').delete().eq('id', album.id));
}

/** Save a new photo order (ids in display order). Only rows whose position changed are written. */
export async function reorderPhotos(rows: PhotoRow[], orderedIds: string[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (let i = 0; i < orderedIds.length; i++) {
    const r = byId.get(orderedIds[i]!);
    if (r && r.position !== i) must(await sb().from('photos').update({ position: i }).eq('id', r.id));
  }
}

// ---------------------------------------------------------------------------------------
// Queries (RLS decides what the viewer may see).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAlbum(id: string): Promise<AlbumRow | null> {
  if (!UUID.test(id)) return null;
  const row = must(await sb().from('albums').select('*').eq('id', id).maybeSingle()) as AlbumRow | null;
  if (row) await people.ensure([row.owner_id]);
  return row;
}

export async function getPhoto(id: string): Promise<PhotoRow | null> {
  if (!UUID.test(id)) return null;
  const row = must(await sb().from('photos').select('*').eq('id', id).maybeSingle()) as PhotoRow | null;
  if (row) await people.ensure([row.owner_id]);
  return row;
}

/** Albums I can read, most recently updated first. */
export async function listAlbums(opts: { ownerId?: string; excludeOwner?: string; limit?: number } = {}): Promise<AlbumRow[]> {
  let q = sb().from('albums').select('*').order('updated_at', { ascending: false }).limit(opts.limit ?? 60);
  if (opts.ownerId) q = q.eq('owner_id', opts.ownerId);
  if (opts.excludeOwner) q = q.neq('owner_id', opts.excludeOwner);
  const rows = must(await q) as AlbumRow[];
  await people.ensure(rows.map((r) => r.owner_id));
  return rows;
}

/** Photos of an album that I can read, in album order. */
export async function albumPhotos(albumId: string): Promise<PhotoRow[]> {
  const rows: PhotoRow[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await sb().from('photos').select('*').eq('album_id', albumId)
      .order('position', { ascending: true }).order('created_at', { ascending: true }).range(from, from + 999)) as PhotoRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  await people.ensure(rows.map((r) => r.owner_id));
  return rows;
}

/** Cover photo (chosen cover, else the first readable photo) and the number of photos I can see. */
export async function albumSummary(album: AlbumRow, coverId?: string): Promise<{ cover: PhotoRow | null; count: number }> {
  const countQ = sb().from('photos').select('id', { count: 'exact', head: true }).eq('album_id', album.id);
  let cover: PhotoRow | null = null;
  if (coverId) cover = must(await sb().from('photos').select('*').eq('id', coverId).eq('album_id', album.id).maybeSingle()) as PhotoRow | null;
  if (!cover) {
    const first = must(await sb().from('photos').select('*').eq('album_id', album.id).order('position').limit(1)) as PhotoRow[];
    cover = first[0] ?? null;
  }
  const { count } = await countQ;
  return { cover, count: count ?? 0 };
}

/** Photos tagged with a user that I can see (via approved/pending tag notices I can read, or my own). */
export async function taggedPhotos(userId: string, limit = 20): Promise<PhotoRow[]> {
  const notices = must(await sb().from('tag_notices').select('photo_id').eq('tagged_id', userId).neq('status', 'removed').order('created_at', { ascending: false }).limit(limit)) as { photo_id: string }[];
  if (!notices.length) return [];
  const rows = must(await sb().from('photos').select('*').in('id', notices.map((n) => n.photo_id))) as PhotoRow[];
  await people.ensure(rows.map((r) => r.owner_id));
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ---------------------------------------------------------------------------------------
// Profile pictures
/** Set my profile picture: upload into "Profile Pictures" and mark files readable by friends. */
export async function setProfilePicture(file: File | Blob): Promise<PhotoFiles> {
  const album = await systemAlbum('profile');
  const [p] = await addPhotos(album, [file]);
  const files = p!.payload.files;
  await linkMedia(photoPaths(files), { photoId: p!.row.id, profileAvatar: true });
  return files;
}

/**
 * Use an existing photo as my profile picture. My own photos shared with all my friends (or public)
 * are re-used as-is; anything else (an Only-Me/list photo, or a friend's photo of me) is copied
 * into "Profile Pictures" so every friend can see the avatar.
 */
export async function profilePictureFromPhoto(row: PhotoRow, payload: PhotoPayload): Promise<PhotoFiles> {
  const shareable = row.owner_id === me() && (row.is_public || row.audience_id === keyring.friendsAudience?.id);
  if (shareable) {
    await linkMedia(photoPaths(payload.files), { photoId: row.id, profileAvatar: true });
    return payload.files;
  }
  return setProfilePicture(await decryptedBlob(payload.files.big));
}

/** Save (or clear) the avatar in my encrypted profile info. */
export async function saveAvatar(files: PhotoFiles | undefined) {
  const prof = getSession().profile;
  const info = myInfo() ?? { name: prof?.display_name_public || prof?.username || '' };
  const next = { ...info };
  if (files) next.avatar = files; else delete next.avatar;
  await saveProfileInfo(next);
}

/** True when the given files are my current avatar. */
export function isMyAvatar(files: PhotoFiles | undefined): boolean {
  const a = myInfo()?.avatar;
  return !!a && !!files && a.thumb.path === files.thumb.path;
}

/**
 * Download + decrypt a file into a Blob. (A blob: URL can't be fetch()ed back under our CSP,
 * whose connect-src doesn't include blob:, so code that needs bytes uses this.)
 */
export async function decryptedBlob(ref: FileRef): Promise<Blob> {
  const res = await sb().storage.from('media').download(ref.path);
  if (res.error || !res.data) throw new Error(res.error?.message ?? 'download failed');
  const plain = decryptFile(new Uint8Array(await res.data.arrayBuffer()), b64u.decode(ref.key), ref.path);
  return new Blob([plain as BlobPart], { type: ref.mime });
}

/** Save the decrypted largest size (for "Download"). */
export async function downloadPhoto(files: PhotoFiles, name = 'photo'): Promise<void> {
  const url = URL.createObjectURL(await decryptedBlob(files.big));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'photo'}.jpg`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Comments / likes on my photo notify the owner (preview sealed to them). */
export async function notifyPhotoOwner(row: PhotoRow, type: 'comment' | 'like', preview?: string) {
  if (row.owner_id === me()) return;
  await notify(row.owner_id, type, 'photo', row.id, preview?.slice(0, 120)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// Friend lists (custom audiences) as album audiences. List names are vault-encrypted by their
// owner (decryptBlob(deriveVaultKey(AMK), name_enc.b, aad)). The social work owns list creation;
// we accept the AADs it may use and fall back to "Custom list".
const LIST_AADS = (id: string) => [`list-name/${id}`, `audience-name/${id}`, `list/${id}`, `audience/${id}/name`, 'list-name', 'audience-name'];

export function listName(row: Pick<AudienceRow, 'id' | 'owner_id' | 'name_enc'>): string | null {
  if (!row.name_enc || row.owner_id !== getSession().userId) return null;
  const enc = row.name_enc as string | { b?: string; blob?: string; name?: string };
  const blob = typeof enc === 'string' ? enc : enc.b ?? enc.blob ?? null;
  if (!blob) return null;
  let vault: Uint8Array;
  try { vault = deriveVaultKey(amk()); } catch { return null; }
  for (const aad of LIST_AADS(row.id)) {
    try {
      const bytes = decryptBlob(vault, blob, aad);
      const text = new TextDecoder().decode(bytes);
      try { const j = JSON.parse(text) as { name?: string }; if (j && typeof j.name === 'string') return j.name; } catch { /* plain text */ }
      return text;
    } catch { /* try the next AAD */ }
  }
  return null;
}

/** My custom friend lists (for the album audience picker). */
export async function myLists(): Promise<{ id: string; name: string }[]> {
  const rows = must(await sb().from('audiences').select('id, owner_id, name_enc').eq('owner_id', me()).eq('kind', 'list')
    .order('created_at')) as Pick<AudienceRow, 'id' | 'owner_id' | 'name_enc'>[];
  return rows.map((r) => ({ id: r.id, name: listName(r) ?? 'Custom list' }));
}

/** Human label for a row's audience (from the viewer's point of view). */
export function audienceLabel(row: Pick<AlbumRow, 'is_public' | 'audience_id' | 'owner_id'>, lists: { id: string; name: string }[] = []): string {
  if (row.is_public) return 'Public — not encrypted';
  if (row.owner_id !== getSession().userId) return 'Encrypted';
  if (row.audience_id === keyring.friendsAudience?.id) return 'Friends';
  if (row.audience_id === keyring.selfAudience?.id) return 'Only Me';
  return lists.find((l) => l.id === row.audience_id)?.name ?? 'Custom list';
}
