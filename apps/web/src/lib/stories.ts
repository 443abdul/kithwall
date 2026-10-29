'use client';
// Stories (24 h), end-to-end encrypted like posts (docs/03-spec.md §3.8): the payload is sealed on this
// device to an audience key (my connections, or a circle) and signed with my identity key. The server
// only stores ciphertext, the audience/epoch, the circle id and the expiry it sets itself
// (supabase/migrations/20261022000300_stories.sql). Photos are re-encoded on device (drops EXIF/GPS),
// encrypted, uploaded, and linked to the story so readers can fetch them only while it is live. Short
// videos (≤ STORY_VIDEO_MAX_S) are encrypted on device and uploaded by the composer (components/posts/
// video.ts), then linked the same way.
import { b64u, openEnvelope, sealEnvelope, type Envelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people } from './people';
import { deleteMedia, fileRefPaths, uploadEncrypted } from './media';
import { ensureCloseList } from './social/closeFriends';
import type { Decrypted } from './content';
import type { FileRef, PostPayload } from './types';

export interface StoryRow {
  id: string; author_id: string; audience_id: string; epoch: number; group_id: string | null;
  envelope: Envelope; created_at: string; expires_at: string;
}

/** Background swatches for text stories (resolved to design tokens by the UI, never raw colours). */
export const STORY_BACKGROUNDS = 6;

export interface StoryPayload {
  text?: string;
  /** Background swatch index for text stories (0 … STORY_BACKGROUNDS-1). */
  bg?: number;
  photo?: { file: FileRef; w: number; h: number };
  /** A short video status (encrypted parts + poster), same shape as a post's video. */
  video?: StoryVideo;
}

export type StoryVideo = NonNullable<PostPayload['video']>;

export type StoryAudience = { kind: 'connections' } | { kind: 'close' } | { kind: 'circle'; circleId: string };

export const STORY_MAX_TEXT = 500;
/** Video statuses are short: at most a minute and 50 MB. */
export const STORY_VIDEO_MAX_S = 60;
export const STORY_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1440;

export function storyHeader(s: Pick<StoryRow, 'id' | 'author_id' | 'audience_id' | 'epoch' | 'group_id'>): EnvelopeHeader {
  return { v: 1, type: 'story', id: s.id, author: s.author_id, ...(s.group_id ? { wall: s.group_id } : {}), audience: { id: s.audience_id, epoch: s.epoch } };
}

async function encodePhoto(file: Blob): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  } finally {
    bitmap.close();
  }
}

async function resolveAudience(a: StoryAudience): Promise<{ audienceId: string; groupId: string | null }> {
  await keyring.whenReady();
  if (a.kind === 'connections') return { audienceId: keyring.friendsAudience!.id, groupId: null };
  if (a.kind === 'close') return { audienceId: await ensureCloseList(), groupId: null };
  const g = must(await sb().from('groups').select('id, audience_id').eq('id', a.circleId).single()) as { id: string; audience_id: string };
  return { audienceId: g.audience_id, groupId: g.id };
}

/** Every storage object a story owns (photo, or video parts + poster). */
export function storyPaths(p: StoryPayload | null | undefined): string[] {
  if (!p) return [];
  return [
    ...(p.photo ? [p.photo.file.path] : []),
    ...(p.video ? [...fileRefPaths(p.video.file), ...(p.video.poster ? [p.video.poster.path] : [])] : []),
  ];
}

/** `video`: already encrypted and uploaded by the composer; on failure here its objects are deleted too. */
export async function createStory(args: { audience: StoryAudience; text?: string; bg?: number; photo?: Blob; video?: { video: StoryVideo; paths: string[] } }): Promise<StoryRow> {
  const id = crypto.randomUUID();
  const { audienceId, groupId } = await resolveAudience(args.audience);
  const { key, epoch } = await keyring.current(audienceId);
  const payload: StoryPayload = {};
  const text = args.text?.trim().slice(0, STORY_MAX_TEXT);
  if (text) payload.text = text;
  if (typeof args.bg === 'number') payload.bg = Math.max(0, Math.min(STORY_BACKGROUNDS - 1, Math.floor(args.bg)));
  let uploaded: string[] = args.video ? [...args.video.paths] : [];
  if (args.video) payload.video = args.video.video;
  try {
    if (args.photo) {
      const enc = await encodePhoto(args.photo);
      const ref = await uploadEncrypted(enc.bytes, 'image/jpeg');
      uploaded = [ref.path];
      payload.photo = { file: { ...ref, w: enc.w, h: enc.h }, w: enc.w, h: enc.h };
    }
    if (!payload.text && !payload.photo && !payload.video) throw new Error('empty story');
    const row = { id, author_id: me(), audience_id: audienceId, epoch, group_id: groupId };
    const envelope = sealEnvelope({ header: storyHeader(row), payload, audienceKey: key, signPriv: identity().signPriv });
    const saved = must(await sb().from('stories').insert({ ...row, envelope }).select().single()) as StoryRow;
    if (uploaded.length) must(await sb().from('media_objects').update({ story_id: id }).in('path', uploaded));
    return saved;
  } catch (e) {
    if (uploaded.length) await deleteMedia(uploaded).catch(() => undefined);
    throw e;
  }
}

/** Live stories I can see (mine included), oldest first. */
export async function listStories(): Promise<StoryRow[]> {
  const rows = must(await sb().from('stories').select('*').gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true }).limit(500)) as StoryRow[];
  await people.ensure(rows.map((r) => r.author_id));
  return rows;
}

const cache = new Map<string, Decrypted<StoryPayload>>();

export function readStory(row: StoryRow): Decrypted<StoryPayload> {
  const hit = cache.get(row.id);
  if (hit?.ok) return hit;
  const author = people.get(row.author_id);
  const key = keyring.get(row.audience_id, row.epoch);
  if (!author || !key) return { ok: false, reason: 'waiting' };
  let res: Decrypted<StoryPayload>;
  try {
    res = { ok: true, value: openEnvelope<StoryPayload>({ header: storyHeader(row), envelope: row.envelope, audienceKey: key, signPub: b64u.decode(author.sign_pub) }) };
  } catch {
    res = { ok: false, reason: 'unverified' };
  }
  cache.set(row.id, res);
  return res;
}

/** Stories I have already opened (my own view rows). */
export async function seenStoryIds(): Promise<Set<string>> {
  const rows = must(await sb().from('story_views').select('story_id').eq('viewer_id', me())) as { story_id: string }[];
  return new Set(rows.map((r) => r.story_id));
}

export async function markStoryViewed(row: StoryRow): Promise<void> {
  if (row.author_id === me()) return;
  const r = await sb().from('story_views').insert({ story_id: row.id, viewer_id: me() });
  if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
}

export interface StoryViewer { viewer_id: string; viewed_at: string }

/** Who viewed my story (RLS: only the author can read these rows). */
export async function storyViewers(storyId: string): Promise<StoryViewer[]> {
  const rows = must(await sb().from('story_views').select('viewer_id, viewed_at').eq('story_id', storyId)
    .order('viewed_at', { ascending: false })) as StoryViewer[];
  await people.ensure(rows.map((r) => r.viewer_id));
  return rows;
}

export async function deleteStory(row: StoryRow, payload?: StoryPayload | null): Promise<void> {
  const paths = storyPaths(payload);
  must(await sb().from('stories').delete().eq('id', row.id));
  cache.delete(row.id);
  if (paths.length) await deleteMedia(paths).catch(() => undefined);
}
