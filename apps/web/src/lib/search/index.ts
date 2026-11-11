'use client';
// Search on your phone (docs/v2/03-safety.md §14): the one index of this device, the "Search on this
// phone" switch, and the calls the decrypting code makes to keep the index in step:
//   noteMessage / notePost / noteComment   right after something was decrypted and verified
//   forgetMessage / forgetPost / forgetComment / forgetChat / forgetAuthor   when it is gone
//   reconcileMessages   after a page of a chat was fetched: what the server no longer has leaves the index
// All of them are cheap and safe to call always: they do nothing while search is off or the app is locked.
// Nothing here talks to the server.
import { onLock } from '../keys/session';
import type { CommentPayload, CommentRow, MessageRow, PostPayload, PostRow } from '../types';
import { SearchIndex, type SearchDoc } from './store';

export { deleteSearchDatabase, type DocKind, type SearchDoc, type SearchHit } from './store';

export const searchIndex = new SearchIndex();

// Locking forgets the decrypted copy and the key; signing out also deletes the database (lib/keys/session
// signOut does that itself, before the session is gone, and the panic wipe deletes every database).
onLock(() => searchIndex.close());

// ------------------------------------------------------------------------------------- the switch
const KEY = 'kw.search';
const listeners = new Set<() => void>();
let wired = false;

/** "Search on this phone": on unless the person switched it off on this device. */
export function searchEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}

/** Switching it off deletes the index at once. */
export function setSearchEnabled(on: boolean) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch { /* storage blocked */ }
  if (!on) { void searchIndex.destroy().then(() => searchIndex.close()); }
  listeners.forEach((l) => l());
}

export function subscribeSearchEnabled(l: () => void): () => void {
  if (!wired && typeof window !== 'undefined') {
    wired = true;
    window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) listeners.forEach((x) => x()); });
  }
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// ------------------------------------------------------------------------------------- feeding
const join = (parts: (string | undefined | null)[]) => parts.filter((p): p is string => !!p && !!p.trim()).join('\n');

interface MessageText { text?: string; subject?: string; link?: { title?: string; description?: string } | null; event?: unknown }

/** A chat message this device just decrypted (system lines and voice notes have no text and are skipped). */
export function noteMessage(row: Pick<MessageRow, 'id' | 'conversation_id' | 'sender_id' | 'created_at' | 'expires_at'>, p: MessageText): void {
  if (!searchIndex.isOpen || p.event) return;
  searchIndex.note({
    id: `m:${row.id}`, kind: 'message', ctx: row.conversation_id, author: row.sender_id, at: row.created_at,
    ...(row.expires_at ? { exp: row.expires_at } : {}),
    text: join([p.subject, p.text, p.link?.title, p.link?.description]),
  });
}

/** The words of a post: what the person wrote, plus titles and captions (never file names or keys). */
export function postText(p: PostPayload): string {
  return join([
    p.text, p.sharedText, p.note?.title, p.note?.body, p.link?.title, p.link?.description, p.video?.title,
    ...(p.photos?.map((x) => x.caption) ?? []), p.poll?.question, ...(p.poll?.options ?? []),
  ]);
}

export function notePost(row: Pick<PostRow, 'id' | 'author_id' | 'created_at' | 'kind' | 'expires_at'>, p: PostPayload): void {
  if (!searchIndex.isOpen) return;
  searchIndex.note({
    id: `p:${row.id}`, kind: 'post', ctx: row.id, author: row.author_id, at: row.created_at,
    ...(row.expires_at ? { exp: row.expires_at } : {}), ...(row.kind === 'note' ? { sub: 'note' } : {}),
    text: postText(p),
  });
}

/** A comment under a post (comments on album photos aren't indexed: there is no page to open them on). */
export function noteComment(row: Pick<CommentRow, 'id' | 'post_id' | 'author_id' | 'created_at'>, p: CommentPayload): void {
  if (!searchIndex.isOpen || !row.post_id) return;
  searchIndex.note({ id: `c:${row.id}`, kind: 'comment', ctx: row.post_id, author: row.author_id, at: row.created_at, text: p.text ?? '' });
}

export const forgetMessage = (id: string) => searchIndex.forget([`m:${id}`]);
export const forgetComment = (id: string) => searchIndex.forget([`c:${id}`]);
/** A post that is gone takes its comments with it. */
export function forgetPost(id: string): void {
  if (!searchIndex.isOpen) return;
  searchIndex.forget([`p:${id}`]);
  void searchIndex.forgetWhere((d) => d.kind === 'comment' && d.ctx === id).catch(() => undefined);
}
/** A chat I left or that was deleted. */
export function forgetChat(conversationId: string): void {
  void searchIndex.forgetWhere((d) => d.kind === 'message' && d.ctx === conversationId).catch(() => undefined);
}
/**
 * Someone I blocked or am no longer connected with: their posts and comments are no longer mine to read, so
 * they leave the index too. Their chat messages stay, as they stay in the chat.
 */
export function forgetAuthor(userId: string): void {
  void searchIndex.forgetWhere((d) => d.kind !== 'message' && d.author === userId).catch(() => undefined);
}

/**
 * After a page of a chat came from the server: indexed messages of that stretch which the server no longer
 * has (unsent or expired while this device wasn't looking) leave the index. `rows` are oldest first;
 * `before` is the page's upper bound (none: up to now); `complete`: the page reaches the chat's beginning.
 */
export function reconcileMessages(conversationId: string, rows: readonly Pick<MessageRow, 'id' | 'created_at' | 'unsent_at'>[],
  opts: { before?: string; complete: boolean }): void {
  if (!searchIndex.isOpen || (!rows.length && !opts.complete)) return;
  const have = new Set(rows.filter((r) => !r.unsent_at).map((r) => `m:${r.id}`));
  const from = opts.complete ? -Infinity : Date.parse(rows[0]!.created_at);
  const to = opts.before ? Date.parse(opts.before) : Infinity;
  void searchIndex.idsWhere((d: SearchDoc) => {
    if (d.kind !== 'message' || d.ctx !== conversationId || have.has(d.id)) return false;
    const at = Date.parse(d.at);
    // Strictly inside the stretch: a message sharing the edge's timestamp may sit on the next page.
    return at > from && at < to;
  }).then((gone) => searchIndex.forget(gone)).catch(() => undefined);
}
