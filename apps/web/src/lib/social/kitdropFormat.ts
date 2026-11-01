// The Kit Drop file format (lib/social/kitdrop): pure parsing, signing and checking, no storage or session.
//
//   { v: 2, kind: 'kithwall-kitdrop', from, made, posts: PostRow[], media: [{ path, h, data }], sig }
//
//  - posts: rows exactly as stored on Kithwall (ciphertext envelopes, each signed by its author).
//  - media: photo ciphertext as stored on Kithwall (the medium size), base64url in `data`; `h` is the
//    base64url SHA-256 of those bytes. Nothing here is decrypted: the key of each photo travels inside its
//    post's encrypted payload, so only people who can read the post can see the photo.
//  - sig: the sender's Ed25519 signature (identity key) over the canonical JSON of everything above, with
//    the media as their (path, hash) pairs. Changing a post, a photo, or which photos are in the file breaks it.
// v1 files (no media) are still read.
import { b64u, canonicalJson, signDetached, verifyDetached } from '@kithwall/crypto';
import type { PostRow } from '../types';

export const KITDROP_KIND = 'kithwall-kitdrop';
/** Dedicated MIME type: lets Android (and installed web apps) offer Kithwall for these files. */
export const KITDROP_MIME = 'application/vnd.kithwall.kitdrop+json';
export const KITDROP_EXT = '.kwd';
/** Photo ciphertext one file carries at most (before base64): enough for dozens of photos at the medium size. */
export const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
/** Posts + photos (base64 grows them by a third) + JSON. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ITEMS = 600;
export const MAX_MEDIA_ITEMS = 300;

/** A storage path in someone's own folder: "<user id>/<file id>". */
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

export interface KitDropMedia { path: string; h: string; data: string }

export interface KitDropFile {
  v: 1 | 2; kind: typeof KITDROP_KIND;
  from: string; made: string;
  /** Post rows as stored on Kithwall (ciphertext envelopes; created_at may be the time it was written offline). */
  posts: PostRow[];
  /** v2: photo ciphertext carried with the posts. */
  media?: KitDropMedia[];
  sig: string;
}

export type KitDropBody = Omit<KitDropFile, 'sig'>;

/** What the signature covers. */
export function sigMessage(f: KitDropBody): string {
  if (f.v === 1) return canonicalJson({ d: 'kithwall/v1/kitdrop', v: 1, from: f.from, made: f.made, posts: f.posts });
  return canonicalJson({
    d: 'kithwall/v2/kitdrop', v: 2, from: f.from, made: f.made, posts: f.posts,
    media: (f.media ?? []).map((m) => ({ path: m.path, h: m.h })),
  });
}

export function signKitDrop(body: KitDropBody, signPriv: Uint8Array): KitDropFile {
  return { ...body, sig: signDetached(sigMessage(body), signPriv) };
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return b64u.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
}

export async function mediaEntry(path: string, bytes: Uint8Array): Promise<KitDropMedia> {
  return { path, h: await sha256(bytes), data: b64u.encode(bytes) };
}

/** Is this probably a Kit Drop file? (A cheap look at the start, for files handed over as "any file".) */
export function looksLikeKitDrop(head: string): boolean {
  return head.trimStart().startsWith('{') && head.includes(`"${KITDROP_KIND}"`);
}

/** Only the columns a reader needs (and that the server would show them anyway). */
export function stripRow(p: PostRow): PostRow {
  return {
    id: p.id, author_id: p.author_id, wall_owner_id: p.wall_owner_id, group_id: p.group_id, event_id: p.event_id,
    kind: p.kind, is_public: p.is_public, audience_id: p.audience_id, epoch: p.epoch, shared_post_id: p.shared_post_id,
    envelope: p.envelope, created_at: p.created_at, edited_at: p.edited_at ?? null,
  };
}

/** Parse a file's text and check its shape. Throws 'not_kitdrop'. Nothing is verified yet (checkKitDrop). */
export function parseKitDrop(text: string): KitDropFile {
  let f: KitDropFile;
  try { f = JSON.parse(text) as KitDropFile; } catch { throw new Error('not_kitdrop'); }
  if (!f || typeof f !== 'object' || f.kind !== KITDROP_KIND || (f.v !== 1 && f.v !== 2) || typeof f.from !== 'string' || typeof f.made !== 'string'
    || typeof f.sig !== 'string' || !Array.isArray(f.posts) || f.posts.length > MAX_ITEMS) throw new Error('not_kitdrop');
  if (f.v === 1 && f.media !== undefined) throw new Error('not_kitdrop');
  if (f.v === 2 && (!Array.isArray(f.media) || f.media.length > MAX_MEDIA_ITEMS
    || !f.media.every((m) => m && typeof m.path === 'string' && PATH_RE.test(m.path) && typeof m.h === 'string' && typeof m.data === 'string'))) {
    throw new Error('not_kitdrop');
  }
  return f;
}

export interface CheckedKitDrop {
  from: string; made: string;
  posts: PostRow[];
  /** Photo ciphertext that matches the signed hashes and belongs to an author of a post in the file. */
  media: { path: string; cipher: Uint8Array }[];
  /** The sender's signature checked out and every photo matched it. */
  verified: boolean;
}

/**
 * Verify a parsed file with the sender's identity key (null: unknown sender). Posts are returned as they are
 * (each is checked again against its author when it is read); photos that don't match their signed hash, or
 * that aren't in the folder of one of the file's authors, are dropped.
 */
export async function checkKitDrop(f: KitDropFile, senderSignPub: Uint8Array | null): Promise<CheckedKitDrop> {
  let verified = !!senderSignPub && verifyDetached(f.sig, sigMessage(f), senderSignPub);
  const posts = f.posts.filter((p) => p && typeof p.id === 'string' && typeof p.author_id === 'string' && p.envelope && typeof p.created_at === 'string').map(stripRow);
  const authors = new Set(posts.map((p) => p.author_id));
  const media: CheckedKitDrop['media'] = [];
  let total = 0;
  for (const m of f.media ?? []) {
    let bytes: Uint8Array;
    try { bytes = b64u.decode(m.data); } catch { verified = false; continue; }
    if (await sha256(bytes) !== m.h) { verified = false; continue; }   // altered after signing
    total += bytes.byteLength;
    if (total > MAX_MEDIA_BYTES) break;
    if (!authors.has(m.path.slice(0, 36))) continue;
    media.push({ path: m.path, cipher: bytes });
  }
  return { from: f.from, made: f.made, posts, media, verified };
}
