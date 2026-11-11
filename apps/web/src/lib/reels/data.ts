'use client';
// Reels: reading and publishing (docs/v2/12-reels.md). A reel is a post of kind 'reel' whose payload has one
// video (re-encoded on the author's device, ./transcode.ts), its cover and a caption.
//
// Reading. Two sources, both plain pages that do not depend on what I watched:
//   - fetchFollowedReels: reels of the people I follow, my connections and my circles (database function
//     reel_feed; row-level security decides each row). Opened like any post: decrypted with the audience key
//     for encrypted ones, signature checked against the author's key this device trusts.
//   - fetchPublicReels: public reels by popularity or by time (explore_posts with kinds ['reel'], the same
//     list for everyone). Opened with the signing key that came with the post, like Explore.
// Which reel plays next is decided on this device (./rank.ts). Nothing here tells the server what was
// watched, for how long, or what was skipped: there is no such request.
//
// Publishing. The video and cover are encrypted on this device and stored exactly like any post video
// (lib/media uploadLargeEncrypted); a Public reel carries their keys in its signed, readable payload, like a
// public post with a video.
import { sb, must } from '../supabase';
import { insertSealedPost, preparePosts, readPost, sealPost, type Audience, type Decrypted } from '../content';
import { clean, linkPostMedia } from '../feed/feed';
import { uploadPreparedImage, type PreparedImage } from '../feed/linkPreview';
import { deleteMedia, fileRefPaths, uploadLargeEncrypted, type ProgressFn } from '../media';
import { fetchPublicPosts, openPublicPost, type PublicCursor, type PublicPostPage, type PublicPostRow, type PublicSort } from '../public/posts';
import { notifyMentions, resolveMentions } from '../social/engage';
import { isOfflineError } from '../net/offline';
import { KeyWaitingError } from '../keys/keyring';
import type { CommentPolicy, PostPayload, PostRow } from '../types';
import { REEL_CAPTION_MAX } from './plan';
import { applySignal, markSeen, reelLang, reelTopics, type ReelCandidate, type ReelSignal } from './rank';
import { updateReelState } from './store';

/** The same page size for everyone and every page: what is fetched says nothing about the reader. */
export const REEL_PAGE = 24;

export interface Reel {
  id: string;
  /** The post row (a PublicPostRow when it came from the public pages). */
  row: PostRow;
  source: 'followed' | 'discover';
  /** Public like and comment counts, for public reels from the public pages. */
  likes?: number;
  comments?: number;
}

const isPublicRow = (row: PostRow): row is PublicPostRow => typeof (row as Partial<PublicPostRow>).author_sign_pub === 'string';

/** The author as told with a reel from the public pages (null for reels of people this device knows). */
export const reelCard = (reel: Reel): PublicPostRow | null => (isPublicRow(reel.row) ? reel.row : null);

/** Decrypt (or, for a public reel, just verify) a reel. Never shows unverified content. */
export function openReel(reel: Reel): Decrypted<PostPayload> {
  const d = isPublicRow(reel.row) ? openPublicPost(reel.row) : readPost(reel.row);
  // A reel without a video is not a reel (a crafted row): treat it like one that failed verification.
  if (d.ok && !d.value.video?.file) return { ok: false, reason: 'unverified' };
  return d;
}

/** What the on-device ranking looks at for one reel. */
export function reelCandidate(reel: Reel, payload: PostPayload): ReelCandidate {
  return {
    id: reel.id, authorId: reel.row.author_id, at: Date.parse(reel.row.created_at) || 0, source: reel.source,
    topics: reelTopics(payload.text), lang: reelLang(payload.lang, payload.text),
    ...(reel.likes !== undefined ? { likes: reel.likes, comments: reel.comments ?? 0 } : {}),
  };
}

/** One page of reels by people I follow, my connections and my circles, newest first. */
export async function fetchFollowedReels(before?: string | null): Promise<{ reels: Reel[]; next: string | null }> {
  const rows = (must(await sb().rpc('reel_feed', { p_before: before ?? null, p_limit: REEL_PAGE })) ?? []) as PostRow[];
  await preparePosts(rows);
  return {
    reels: rows.map((row) => ({ id: row.id, row, source: 'followed' as const })),
    next: rows.length === REEL_PAGE ? rows[rows.length - 1]!.created_at : null,
  };
}

/** One page of public reels: the generic list everyone gets ('popular' or 'recent'). */
export async function fetchPublicReels(sort: PublicSort, cursor?: PublicCursor | null): Promise<{ reels: Reel[]; next: PublicPostPage['next'] }> {
  const page = await fetchPublicPosts({ sort, kinds: ['reel'], limit: REEL_PAGE }, cursor);
  return {
    reels: page.rows.map((row) => ({ id: row.id, row, source: 'discover' as const, likes: row.like_count, comments: row.comment_count })),
    next: page.next,
  };
}

// ------------------------------------------------------------------------------------- what this device learns
/** Note, on this device only, something I did with a reel (./store.ts; never sent anywhere). */
export function recordReelSignal(c: Pick<ReelCandidate, 'id' | 'authorId' | 'topics' | 'lang'>, signal: ReelSignal): void {
  updateReelState((s) => ({ profile: applySignal(s.profile, c, signal, Date.now()) }));
}

/** Note, on this device only, that a reel was shown. */
export function recordReelSeen(id: string): void {
  updateReelState((s) => ({ profile: markSeen(s.profile, id, Date.now()) }));
}

// ------------------------------------------------------------------------------------- publishing
export interface NewReel {
  video: { blob: Blob; mime: string; w: number; h: number; duration: number };
  cover: PreparedImage | null;
  caption: string;
  audience: Audience;
  /** Set when the reel goes into a circle. */
  groupId?: string;
  /** The language my app is in (two letters). */
  lang: string;
  commentPolicy?: CommentPolicy | null;
}

export type ReelPublishProblem = 'limit' | 'too_big' | 'off' | 'offline' | 'key' | 'failed';

export class ReelPublishError extends Error {
  constructor(public problem: ReelPublishProblem) { super(`reel publish: ${problem}`); this.name = 'ReelPublishError'; }
}

function problemOf(e: unknown): ReelPublishProblem {
  const code = (e as { code?: string } | null)?.code;
  const message = (e as { message?: string } | null)?.message ?? '';
  if (e instanceof KeyWaitingError) return 'key';
  if (isOfflineError(e)) return 'offline';
  if (code === 'P0429' || /rate limit/i.test(message)) return 'limit';
  if (code === 'P0413' || /at most \d+ MB|maximum allowed size|too large/i.test(message)) return 'too_big';
  if (/reels are turned off/i.test(message)) return 'off';
  return 'failed';
}

/**
 * Encrypt, upload and post a reel. `onPhase` / `onProgress` drive the progress bar; `signal` cancels (what
 * was already uploaded is removed again). Throws ReelPublishError, or an AbortError when cancelled.
 */
export async function publishReel(reel: NewReel, opts: { onPhase?: (p: 'encrypt' | 'upload' | 'share') => void; onProgress?: ProgressFn; signal?: AbortSignal } = {}): Promise<PostRow> {
  const id = crypto.randomUUID();
  const uploaded: string[] = [];
  try {
    opts.onPhase?.('encrypt');
    const bytes = new Uint8Array(await reel.video.blob.arrayBuffer());
    const file = await uploadLargeEncrypted(bytes, reel.video.mime, {
      signal: opts.signal,
      onProgress: (sent, total) => { opts.onPhase?.('upload'); opts.onProgress?.(sent, total); },
    });
    uploaded.push(...fileRefPaths(file));
    const poster = reel.cover ? await uploadPreparedImage(reel.cover).catch(() => undefined) : undefined;
    if (poster) uploaded.push(poster.path);
    if (opts.signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
    opts.onPhase?.('share');
    const caption = reel.caption.trim().slice(0, REEL_CAPTION_MAX);
    const wide = reel.audience.kind === 'followers' || reel.audience.kind === 'public';
    const mentioned = caption ? await resolveMentions(caption, wide).catch(() => [] as string[]) : [];
    const payload: PostPayload = clean({
      ...(caption ? { text: caption } : {}),
      video: {
        file: { ...file, w: reel.video.w, h: reel.video.h },
        ...(poster ? { poster } : {}),
        duration: Math.round(reel.video.duration * 10) / 10, w: reel.video.w, h: reel.video.h,
      },
      ...(mentioned.length ? { mentions: mentioned } : {}),
      ...(/^[a-z]{2,3}$/.test(reel.lang) ? { lang: reel.lang } : {}),
    });
    const sealed = await sealPost({ id, kind: 'reel', payload, audience: reel.audience, groupId: reel.groupId, commentPolicy: reel.commentPolicy ?? null });
    const row = await insertSealedPost(sealed);
    // The database accepts the files only if they are stored and within the cap for reels.
    await linkPostMedia(uploaded, id);
    if (mentioned.length) await notifyMentions(mentioned, 'post', id);
    return row;
  } catch (e) {
    if (uploaded.length) await deleteMedia(uploaded).catch(() => undefined);
    // A post row without its files is of no use to anyone.
    await Promise.resolve(sb().from('posts').delete().eq('id', id)).catch(() => undefined);
    if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
    throw new ReelPublishError(problemOf(e));
  }
}
