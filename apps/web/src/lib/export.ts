'use client';
// "Download your data" (spec §5 Export; docs/v2/03-transparency.md §4): everything I own or take part in
// that I can read is fetched, verified and decrypted ON THIS DEVICE, then zipped (fflate). Nothing
// decrypted leaves the browser except as the file the user saves.
//
// kithwall-<handle>-<date>.zip
//   index.html                       readable overview (open in any browser, no network)
//   README.txt
//   data/*.json                      profile, connections, posts, notes, comments, reactions, albums,
//                                    photos, stories, circles, events, messages, settings, and
//                                    what-kithwall-knows.json (the server's live inventory, /you/privacy-report)
//   media/albums/<album>/<id>.jpg    decrypted photos (largest size)
//   media/posts/<post id>-<n>.jpg    photos attached to my posts
//   media/stories/<story id>.jpg     my live stories
//   media/messages/<chat>/<id>-<n>   images I can read in my chats
//   data/classic/*.json              Kithwall Classic (v1) data that Kithwall 2 no longer shows: pokes,
//                                    Kithville, Pages, questions and votes, friend lists, classic posts
//                                    (only when the account has any; also downloadable on its own with
//                                    buildClassicExport(), see "Kithwall Classic data" below)
// Videos and files bigger than MAX_FILE stay in Kithwall (listed with "file": null, "skipped": "too_large").
import {
  b64u, decryptBlob, decryptFile, deriveSubkey, deriveVaultKey, openEnvelope, openSealed, openWithContentKey,
  type Envelope, type EnvelopeHeader, type Sealed,
} from '@kithwall/crypto';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { sb, must } from './supabase';
import { amk, getSession, identity, me } from './keys/session';
import { keyring } from './keys/keyring';
import { people } from './people';
import { myFriendIds } from './friends';
import { postContentKey, preparePosts, readComment, readPost } from './content';
import { photoContentKey, readAlbum, readPhoto, type AlbumRow, type PhotoRow } from './photos';
import { listConversations, readMessage, fetchMessages, readName, type ConversationSummary } from './messages';
import { readGroup, type GroupRow, type MemberRow } from './groups';
import { readEvent, type EventRow } from './events';
import { readStory, type StoryRow } from './stories';
import { fetchReactions, readReaction, type ReactionRow } from './chat/reactions';
import { fetchTransparencyReport } from './transparency/report';
import type { CommentRow, FileRef, LikeRow, MessageRow, PostPayload, PostRow } from './types';

export type ExportStep =
  | 'profile' | 'posts' | 'comments' | 'albums' | 'photos' | 'stories' | 'circles' | 'events'
  | 'messages' | 'settings' | 'inventory' | 'classic' | 'packaging';
export type Progress = (step: ExportStep, done?: number, total?: number) => void;

const PAGE = 500;
/** Files larger than this are listed but not copied into the ZIP (it is built in memory). */
export const MAX_FILE = 25 * 1024 * 1024;

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = must(await build(from, from + PAGE - 1)) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function fileBytes(ref: FileRef): Promise<Uint8Array> {
  const res = await sb().storage.from('media').download(ref.path);
  if (res.error || !res.data) throw new Error(res.error?.message ?? 'download failed');
  return decryptFile(new Uint8Array(await res.data.arrayBuffer()), b64u.decode(ref.key), ref.path);
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };
export const extOf = (mime: string | undefined) => EXT[mime ?? ''] ?? 'bin';

/** Copy one decrypted file into the ZIP; returns its path, or why it was left out. */
async function addFile(files: Zippable, path: string, ref: FileRef | undefined | null): Promise<{ file: string | null; skipped?: 'too_large' | 'failed' }> {
  if (!ref?.path || !ref.key) return { file: null, skipped: 'failed' };
  if (ref.parts?.length || (ref.bytes ?? 0) > MAX_FILE) return { file: null, skipped: 'too_large' };
  try { files[path] = [await fileBytes(ref), { level: 0 }]; return { file: path }; } catch { return { file: null, skipped: 'failed' }; }
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'album';
const nameOf = (id: string | null | undefined) => { if (!id) return ''; const p = people.person(id); return p ? `${p.name} (@${p.username})` : id; };
/** The made-up sign-in address of passkey/passphrase accounts is not an email; never export it as one. */
export const realEmail = (e: string | null | undefined) => (e && !/@id\.kithwall\.invalid$/i.test(e) ? e : null);

export interface ExportSummary {
  posts: number; comments: number; photos: number; messages: number; skipped: number; bytes: number;
  notes: number; stories: number; circles: number; events: number; reactions: number; files: number; tooLarge: number;
}

type Row<T> = T & Record<string, unknown>;

export async function buildExport(progress: Progress = () => undefined): Promise<{ blob: Blob; filename: string; summary: ExportSummary }> {
  const s = getSession();
  if (s.status !== 'ready' || !s.profile) throw new Error('Unlock Kithwall first.');
  const myId = me();
  let skipped = 0;
  let tooLarge = 0;
  let fileCount = 0;
  const files: Zippable = {};
  const problems: { what: string; why: string }[] = [];
  const note = (r: { file: string | null; skipped?: string }) => { if (r.file) fileCount++; else if (r.skipped === 'too_large') tooLarge++; else skipped++; return r; };
  await keyring.load().catch(() => undefined);

  // Profile & connections --------------------------------------------------------------------------------
  progress('profile');
  await people.refreshInfo(myId);
  const info = people.person(myId)?.info ?? null;
  const friendIds = await myFriendIds();
  await people.ensure(friendIds);
  const friends = friendIds.map((id) => { const p = people.person(id); return { id, username: p?.username, name: p?.name }; });
  const blocked = (must(await sb().from('blocks').select('blocked, created_at').eq('blocker', myId)) as { blocked: string; created_at: string }[]);
  await people.ensure(blocked.map((b) => b.blocked));
  const profile = {
    id: myId, username: s.profile.username, email: realEmail(s.email), created_at: s.profile.created_at,
    directory_name: s.profile.display_name_public, public_keys: { sign: s.profile.sign_pub, kx: s.profile.kx_pub }, info,
  };

  // Posts (mine, and others' posts on my wall), notes, likes ---------------------------------------------------
  progress('posts');
  const postRows = await all<Row<PostRow>>((a, b) => sb().from('posts').select('*').or(`author_id.eq.${myId},wall_owner_id.eq.${myId}`).order('created_at').range(a, b));
  await preparePosts(postRows);
  const posts: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
  let pi = 0;
  for (const r of postRows) {
    progress('posts', ++pi, postRows.length);
    const d = readPost(r);
    if (!d.ok) skipped++;
    const media: { file: string | null; caption?: string; skipped?: string }[] = [];
    if (d.ok && r.author_id === myId) {
      let i = 0;
      for (const ph of d.value.photos ?? []) {
        const res = note(await addFile(files, `media/posts/${r.id}-${++i}.${extOf(ph.files.big.mime)}`, ph.files.big));
        media.push({ ...res, caption: ph.caption });
      }
      if (d.value.video) media.push(note(await addFile(files, `media/posts/${r.id}-video.${extOf(d.value.video.file.mime)}`, d.value.video.file)));
    }
    posts.push({
      id: r.id, created_at: r.created_at, edited_at: r.edited_at ?? null, kind: r.kind, author: nameOf(r.author_id),
      audience: r.is_public ? 'public' : r.group_id ? `circle:${r.group_id}` : r.audience_id,
      publish_at: r.publish_at ?? null, expires_at: r.expires_at ?? null,
      content: d.ok ? d.value : null, media, status: d.ok ? 'ok' : d.reason,
    });
    if (r.kind === 'note' && d.ok && d.value.note) notes.push({ id: r.id, created_at: r.created_at, edited_at: r.edited_at ?? null, title: d.value.note.title, body: d.value.note.body });
  }
  const likeRows = await all<LikeRow>((a, b) => sb().from('likes').select('*').eq('user_id', myId).order('created_at').range(a, b));

  // My comments --------------------------------------------------------------------------------------------
  progress('comments');
  const commentRows = await all<Row<CommentRow>>((a, b) => sb().from('comments').select('*').eq('author_id', myId).order('created_at').range(a, b));
  const parentPostIds = [...new Set(commentRows.map((c) => c.post_id).filter(Boolean) as string[])];
  const parentPhotoIds = [...new Set(commentRows.map((c) => c.photo_id).filter(Boolean) as string[])];
  const parentPosts = new Map<string, PostRow>();
  for (let i = 0; i < parentPostIds.length; i += 100) {
    (must(await sb().from('posts').select('*').in('id', parentPostIds.slice(i, i + 100))) as PostRow[]).forEach((p) => parentPosts.set(p.id, p));
  }
  const parentPhotos = new Map<string, PhotoRow>();
  for (let i = 0; i < parentPhotoIds.length; i += 100) {
    (must(await sb().from('photos').select('*').in('id', parentPhotoIds.slice(i, i + 100))) as PhotoRow[]).forEach((p) => parentPhotos.set(p.id, p));
  }
  await preparePosts([...parentPosts.values()]);
  const comments = commentRows.map((c) => {
    let key: Uint8Array | null = null;
    let reachable = true;
    try {
      if (c.post_id) { const p = parentPosts.get(c.post_id); reachable = !!p; key = p ? postContentKey(p) : null; if (p?.is_public) key = null; }
      else if (c.photo_id) { const p = parentPhotos.get(c.photo_id); reachable = !!p; key = p ? photoContentKey(p) : null; }
    } catch { reachable = false; }
    const d = reachable ? readComment(c, key) : ({ ok: false, reason: 'waiting' } as const);
    if (!d.ok) skipped++;
    return { id: c.id, created_at: c.created_at, edited_at: c.edited_at ?? null, on_post: c.post_id, on_photo: c.photo_id, text: d.ok ? d.value.text : null, status: d.ok ? 'ok' : d.reason };
  });

  // Albums & photos (with decrypted image files) ---------------------------------------------------------------
  progress('albums');
  const albumRows = await all<AlbumRow>((a, b) => sb().from('albums').select('*').eq('owner_id', myId).order('created_at').range(a, b));
  const photoRows = await all<PhotoRow>((a, b) => sb().from('photos').select('*').eq('owner_id', myId).order('created_at').range(a, b));
  const albums = albumRows.map((a) => {
    const d = readAlbum(a);
    if (!d.ok) skipped++;
    return { id: a.id, created_at: a.created_at, name: d.ok ? d.value.name : null, description: d.ok ? d.value.description : null, folder: `media/albums/${slug(d.ok ? d.value.name : a.id)}-${a.id.slice(0, 8)}` };
  });
  const photos: { id: string; album: string; created_at: string; caption?: string; tags: string[]; file: string | null; skipped?: string }[] = [];
  let n = 0;
  for (const p of photoRows) {
    progress('photos', ++n, photoRows.length);
    const d = readPhoto(p);
    const album = albums.find((a) => a.id === p.album_id);
    if (!d.ok) { skipped++; continue; }
    const big = d.value.files.big;
    const res = note(await addFile(files, `${album?.folder ?? 'media/albums/other'}/${p.id}.${extOf(big.mime)}`, big));
    await people.ensure(d.value.tags.map((t) => t.id));
    photos.push({ id: p.id, album: album?.name ?? '', created_at: p.created_at, caption: d.value.caption, tags: d.value.tags.map((t) => nameOf(t.id)), ...res });
  }

  // My live stories (they disappear after 24 hours) -------------------------------------------------------------
  progress('stories');
  const storyRows = must(await sb().from('stories').select('*').eq('author_id', myId).order('created_at')) as StoryRow[];
  const stories: Record<string, unknown>[] = [];
  for (const r of storyRows) {
    const d = readStory(r);
    if (!d.ok) { skipped++; stories.push({ id: r.id, created_at: r.created_at, expires_at: r.expires_at, status: d.reason }); continue; }
    const media = d.value.photo ? note(await addFile(files, `media/stories/${r.id}.${extOf(d.value.photo.file.mime)}`, d.value.photo.file)) : null;
    stories.push({ id: r.id, created_at: r.created_at, expires_at: r.expires_at, circle: r.group_id, text: d.value.text ?? null, photo: media, status: 'ok' });
  }

  // Circles and events I belong to ------------------------------------------------------------------------------
  progress('circles');
  const memberships = must(await sb().from('audience_members').select('*').eq('member_id', myId)) as MemberRow[];
  const byAud = new Map(memberships.map((m) => [m.audience_id, m]));
  const groupRows = (must(await sb().from('groups').select('*').order('created_at')) as GroupRow[])
    .filter((g) => g.creator_id === myId || byAud.has(g.audience_id));
  await people.ensure(groupRows.flatMap((g) => [g.creator_id, g.envelope_by ?? '']).filter(Boolean));
  const circles = groupRows.map((g) => {
    const d = readGroup(g);
    if (!d.ok) skipped++;
    const m = byAud.get(g.audience_id);
    return { id: g.id, created_at: g.created_at, created_by: nameOf(g.creator_id), my_role: m?.role ?? (g.creator_id === myId ? 'admin' : null), my_status: m?.status ?? null, joined_at: m?.created_at ?? null, info: d.ok ? d.value : null, status: d.ok ? 'ok' : d.reason };
  });
  progress('events');
  const eventRows = (must(await sb().from('events').select('*').order('created_at').limit(2000)) as Row<EventRow>[])
    .filter((e) => e.host_id === myId || byAud.has(e.audience_id));
  await people.ensure(eventRows.flatMap((e) => [e.host_id, e.envelope_by ?? '']).filter(Boolean));
  const events = eventRows.map((e) => {
    const d = readEvent(e);
    if (!d.ok) skipped++;
    const m = byAud.get(e.audience_id);
    return { id: e.id, created_at: e.created_at, host: nameOf(e.host_id), circle: e.group_id ?? null, my_answer: m?.rsvp ?? null, info: d.ok ? d.value : null, status: d.ok ? 'ok' : d.reason };
  });

  // Messages in conversations I'm part of, with reactions ------------------------------------------------------------
  progress('messages');
  const convs: ConversationSummary[] = await listConversations(1000);
  type OutMsg = { id: string; at: string; from: string; text: string | null; status: string; edited_at?: string | null; attachments?: { file: string | null; skipped?: string }[]; reactions?: { from: string; emoji: string }[]; event?: unknown };
  const conversations: { id: string; name: string | null; with: string[]; messages: OutMsg[] }[] = [];
  const myMessageReactions: { conversation: string; message: string; emoji: string; at: string }[] = [];
  let ci = 0;
  for (const c of convs) {
    progress('messages', ++ci, convs.length);
    const msgs: OutMsg[] = [];
    const rows: Row<MessageRow>[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await fetchMessages(c, before, 50) as Row<MessageRow>[];
      if (!page.length) break;
      rows.push(...page);
      before = page[0]!.created_at;
      if (page.length < 50) break;
    }
    let reactions: ReactionRow[] = [];
    try { reactions = await fetchReactions(c.id, rows.map((r) => r.id)); } catch { /* reactions are optional */ }
    for (const r of rows) {
      if (r.unsent_at) continue;
      if (r.notice) { msgs.push({ id: r.id, at: r.created_at, from: nameOf(r.sender_id), text: null, status: 'notice', event: r.notice }); continue; }
      const d = readMessage(c, r);
      if (!d.ok) skipped++;
      const out: OutMsg = { id: r.id, at: r.created_at, from: nameOf(r.sender_id), text: d.ok ? d.value.text : null, status: d.ok ? 'ok' : d.reason, edited_at: (r.edited_at as string | null | undefined) ?? null };
      if (d.ok && d.value.event) out.event = d.value.event;
      if (d.ok && d.value.attachments?.length) {
        out.attachments = [];
        let i = 0;
        for (const a of d.value.attachments) out.attachments.push(note(await addFile(files, `media/messages/${c.id.slice(0, 8)}/${r.id}-${++i}.${extOf(a.mime)}`, a)));
      }
      const rs = reactions.filter((x) => x.message_id === r.id).map((x) => ({ x, emoji: readReaction(c.audience_id, x) })).filter((y) => y.emoji);
      if (rs.length) out.reactions = rs.map((y) => ({ from: nameOf(y.x.user_id), emoji: y.emoji! }));
      for (const y of rs) if (y.x.user_id === myId) myMessageReactions.push({ conversation: c.id, message: r.id, emoji: y.emoji!, at: y.x.updated_at });
      msgs.push(out);
    }
    msgs.sort((a, b) => a.at.localeCompare(b.at));
    let name: string | null = null;
    try { const nm = readName({ audience_id: c.audience_id, nameEnc: (c as unknown as { nameEnc?: unknown }).nameEnc }); name = nm.ok ? nm.value : null; } catch { name = null; }
    conversations.push({ id: c.id, name, with: c.members.filter((m) => m !== myId).map(nameOf), messages: msgs });
  }

  // Settings (my whole encrypted vault, decrypted here) ----------------------------------------------------------------
  progress('settings');
  let settings: unknown = null;
  try {
    const row = (await sb().from('vault').select('blob, updated_at').eq('user_id', myId).maybeSingle()).data as { blob: string; updated_at: string } | null;
    settings = row ? { updated_at: row.updated_at, ...JSON.parse(new TextDecoder().decode(decryptBlob(deriveVaultKey(amk()), row.blob, `vault/${myId}`))) } : {};
  } catch (e) { skipped++; problems.push({ what: 'settings', why: (e as Error).message }); }

  // The server's own inventory about me (the same as /you/privacy-report) ------------------------------------------------
  progress('inventory');
  let inventory: unknown = null;
  try { inventory = await fetchTransparencyReport(); } catch (e) { inventory = { error: 'unavailable' }; problems.push({ what: 'inventory', why: (e as Error).message }); }

  // Kithwall Classic data (only if this account used Kithwall before Kithwall 2) --------------------------------------
  progress('classic');
  let classic: ClassicData | null = null;
  try {
    if (await hasClassicData()) { classic = await collectClassic(myId); skipped += classic.skipped; problems.push(...classic.problems); }
  } catch (e) { problems.push({ what: 'classic', why: (e as Error).message }); }

  // Assemble ------------------------------------------------------------------------------------------------------
  progress('packaging');
  if (classic) for (const [name, value] of Object.entries(classic.files)) files[`data/classic/${name}`] = strToU8(JSON.stringify(value, null, 2));
  const json = (o: unknown) => strToU8(JSON.stringify(o, null, 2));
  const reactionsOut = {
    on_posts_comments_photos: likeRows.map((l) => ({ kind: l.target_kind, id: l.target_id, at: l.created_at })),
    in_messages: myMessageReactions,
  };
  files['data/profile.json'] = json(profile);
  files['data/connections.json'] = json({ connections: friends, blocked: blocked.map((b) => ({ who: nameOf(b.blocked), at: b.created_at })) });
  files['data/posts.json'] = json(posts);
  files['data/notes.json'] = json(notes);
  files['data/comments.json'] = json(comments);
  files['data/reactions.json'] = json(reactionsOut);
  files['data/albums.json'] = json(albums);
  files['data/photos.json'] = json(photos);
  files['data/stories.json'] = json(stories);
  files['data/circles.json'] = json(circles);
  files['data/events.json'] = json(events);
  files['data/messages.json'] = json(conversations);
  files['data/settings.json'] = json(settings);
  files['data/what-kithwall-knows.json'] = json(inventory);
  if (problems.length) files['data/export-problems.json'] = json(problems);
  const generated = new Date();
  const summary: ExportSummary = {
    posts: posts.length, comments: comments.length, photos: photos.length,
    messages: conversations.reduce((a, c) => a + c.messages.length, 0), skipped, bytes: 0,
    notes: notes.length, stories: stories.length, circles: circles.length, events: events.length,
    reactions: likeRows.length + myMessageReactions.length, files: fileCount, tooLarge,
  };
  files['index.html'] = strToU8(renderIndex({ profile, friends, posts, notes, photos, stories, circles, events, conversations, generated, summary }));
  files['README.txt'] = strToU8(
    `Your Kithwall information, exported ${generated.toISOString()}.\n\n` +
    `Everything here was decrypted on your own device. Keep this file safe: it is NOT encrypted.\n` +
    `Open index.html in a browser, or use the JSON files in data/. Photos and other files are in media/.\n` +
    `data/what-kithwall-knows.json is what our server holds about your account (counts and readable values only).\n` +
    (skipped ? `\n${skipped} item(s) could not be decrypted or verified and are listed without content.\n` : '') +
    (tooLarge ? `\n${tooLarge} file(s) larger than ${MAX_FILE / 1048576} MB (mostly videos) were left out; download them from Kithwall.\n` : '') +
    (classic ? `\ndata/classic/ has your Kithwall Classic data (pokes, Kithville, Pages, questions, friend lists), which Kithwall 2 no longer shows.\n` : ''));

  const zipped = zipSync(files, { level: 6 });
  summary.bytes = zipped.byteLength;
  const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
  return { blob, filename: `kithwall-${s.profile.username}-${generated.toISOString().slice(0, 10)}.zip`, summary };
}

type Content = { text?: string; note?: { title?: string; body?: string }; link?: { url?: string } } | null;

function renderIndex(d: {
  profile: { username: string; email: string | null; info: unknown };
  friends: { username?: string; name?: string }[];
  posts: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  photos: { album: string; caption?: string; file: string | null }[];
  stories: Record<string, unknown>[];
  circles: { info: unknown; my_role: string | null }[];
  events: { info: unknown; my_answer: string | null }[];
  conversations: { name: string | null; with: string[]; messages: { at: string; from: string; text: string | null; status: string }[] }[];
  generated: Date; summary: ExportSummary;
}): string {
  const info = (d.profile.info ?? {}) as { name?: string };
  const postText = (c: unknown) => { const x = c as Content; return x?.text ?? x?.note?.title ?? x?.link?.url ?? ''; };
  const sec = (title: string, count: number, body: string) => `<section><h2>${esc(title)} <span class="n">${count}</span></h2>${body || '<p class="g">Nothing here.</p>'}</section>`;
  const msgText = (m: { text: string | null; status: string }) => (m.status === 'notice' ? '<i>(notice)</i>' : esc(m.text ?? '(could not be decrypted)'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kithwall: ${esc(info.name ?? d.profile.username)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:26px;margin:8px 0}h2{font-size:18px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid #8884}.n{font-weight:400;opacity:.6}
.it{border-bottom:1px solid #8882;padding:8px 0}.g{opacity:.65;font-size:13px}img{max-width:180px;max-height:180px;border-radius:8px;margin:4px;object-fit:cover}
.note{white-space:pre-wrap}</style></head><body>
<h1>${esc(info.name ?? d.profile.username)}</h1>
<p class="g">@${esc(d.profile.username)}${d.profile.email ? ` &middot; ${esc(d.profile.email)}` : ''} &middot; exported ${esc(d.generated.toUTCString())}.<br>Decrypted on your device; this copy is not encrypted.${d.summary.skipped ? ` ${d.summary.skipped} item(s) could not be decrypted.` : ''}${d.summary.tooLarge ? ` ${d.summary.tooLarge} large file(s) were left out.` : ''}</p>
${sec('Connections', d.friends.length, d.friends.map((f) => `<div class="it">${esc(f.name)} <span class="g">@${esc(f.username)}</span></div>`).join(''))}
${sec('Posts', d.posts.length, d.posts.map((p) => `<div class="it"><b>${esc(p.author)}</b> ${esc(postText(p.content))}${p.status !== 'ok' ? ' <span class="g">(could not be decrypted)</span>' : ''}${((p.media as { file: string | null }[]) ?? []).filter((m) => m.file && /\.(jpe?g|png|webp|gif)$/.test(m.file)).map((m) => `<br><a href="${esc(m.file)}"><img src="${esc(m.file)}" alt=""></a>`).join('')}<div class="g">${esc(p.created_at)}</div></div>`).join(''))}
${sec('Notes', d.notes.length, d.notes.map((n) => `<div class="it"><b>${esc(n.title)}</b><div class="note">${esc(n.body)}</div><div class="g">${esc(n.created_at)}</div></div>`).join(''))}
${sec('Photos', d.photos.length, d.photos.map((p) => (p.file ? `<a href="${esc(p.file)}"><img src="${esc(p.file)}" alt="${esc(p.caption ?? p.album)}"></a>` : '')).join(''))}
${sec('Stories', d.stories.length, d.stories.map((s) => `<div class="it">${esc(s.text ?? '')}${(s.photo as { file?: string } | null)?.file ? `<br><img src="${esc((s.photo as { file: string }).file)}" alt="">` : ''}<div class="g">${esc(s.created_at)}</div></div>`).join(''))}
${sec('Circles', d.circles.length, d.circles.map((c) => `<div class="it">${esc((c.info as { name?: string } | null)?.name ?? '(could not be decrypted)')} <span class="g">${esc(c.my_role ?? '')}</span></div>`).join(''))}
${sec('Events', d.events.length, d.events.map((e) => { const i = e.info as { name?: string; start?: string } | null; return `<div class="it">${esc(i?.name ?? '(could not be decrypted)')} <span class="g">${esc(i?.start ?? '')} ${esc(e.my_answer ?? '')}</span></div>`; }).join(''))}
${sec('Messages', d.conversations.length, d.conversations.map((c) => `<div class="it"><b>${esc(c.name ?? `With ${c.with.join(', ') || 'only you'}`)}</b>${c.messages.map((m) => `<div><span class="g">${esc(m.at)}</span> <b>${esc(m.from)}:</b> ${msgText(m)}</div>`).join('')}</div>`).join(''))}
<p class="g">The data/ folder has everything above as JSON, plus your reactions, settings and what our server knows about your account.</p>
</body></html>`;
}

/** Save a blob as a file via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------------------------
// Kithwall Classic data (docs/v2/07-launch.md §5)
//
// What a v1 (2010-style) account has that Kithwall 2 no longer shows. The tables are dropped 30 days after
// launch (supabase/launch/drop_classic_tables.sql), so people can download it until then: in the full export
// (data/classic/) or on its own (buildClassicExport). Decrypted here, with the same keys as v1:
//   pokes        plain rows (who, when)
//   kithville    the farm (vault key, aad "kithville/<me>"), gifts/help received (sealed to me); sent ones are
//                sealed to the friend, so only who/when is known
//   pages        Pages I created (public data) with their posts, and the Pages I liked (classic_* RPCs: the
//                Page rows are hidden while the Public switch is off)
//   questions    my questions with every readable vote tallied; my votes on friends' questions
//   friend lists list names (vault key, aad "list-name/<me>") and members
//   posts        my check-ins, life events, questions and Kithville posts (Kithville posts are hidden in v2)
// Every part fails soft: once the tables are gone, hasClassicData() is false and the section disappears.
// ---------------------------------------------------------------------------------------------
const CLASSIC_POST_KINDS = ['question', 'checkin', 'life_event', 'game'] as const;

export interface ClassicSummary {
  pokes: number; kithville: boolean; gifts: number; pages: number; likedPages: number; pagePosts: number;
  questions: number; votes: number; lists: number; posts: number;
}
interface ClassicData {
  files: ClassicFiles;
  summary: ClassicSummary;
  skipped: number;
  problems: { what: string; why: string }[];
}
interface ClassicFiles {
  'pokes.json': { direction: 'sent' | 'received'; who: string; at: string }[];
  'kithville.json': {
    saved_at: string | null; version: number | null; level: number | null; coins: unknown; xp: number | null;
    farm: Record<string, unknown> | null;
    gifts_and_help: { kind: string; at: string; claimed_at: string | null; direction: 'sent' | 'received'; to?: string; from?: string; content?: unknown }[];
  } | null;
  'pages.json': {
    created: { id: string; name: string; category: string; about: string | null; created_at: string; likes: number;
      posts: { id: string; created_at: string; kind: string; author: string; content: unknown; status: string }[] }[];
    liked: { id: string; name: string; category: string; about: string | null; liked_at: string }[];
  };
  'questions.json': {
    asked: { id: string; created_at: string; question: string | null; results: { option: string; votes: string[] }[]; votes: { who: string; choice: string | null; at: string }[] }[];
    answered: { question_id: string; asked_by: string | null; question: string | null; my_answer: string | null; at: string }[];
  };
  'friend-lists.json': { id: string; name: string | null; created_at: string; members: string[] }[];
  'posts.json': { id: string; created_at: string; kind: string; on_wall_of: string | null; content: unknown; status: string }[];
}

type HeadCount = PromiseLike<{ count: number | null; error: unknown }>;
const countOf = (q: HeadCount) => Promise.resolve(q).then((r) => (r.error ? 0 : r.count ?? 0), () => 0);

/** Does this account have any Kithwall Classic data? Cheap head-only counts; false once the tables are gone. */
export async function hasClassicData(): Promise<boolean> {
  const myId = me();
  const head = { count: 'exact', head: true } as const;
  const counts = await Promise.all([
    countOf(sb().from('pokes').select('from_id', head).or(`from_id.eq.${myId},to_id.eq.${myId}`)),
    countOf(sb().from('game_state').select('user_id', head).eq('user_id', myId)),
    countOf(sb().from('game_actions').select('id', head).or(`from_id.eq.${myId},to_id.eq.${myId}`)),
    countOf(sb().from('pages').select('id', head).eq('owner_id', myId)),
    countOf(sb().from('page_likes').select('page_id', head).eq('user_id', myId)),
    countOf(sb().from('poll_votes').select('post_id', head).eq('voter_id', myId)),
    countOf(sb().from('audiences').select('id', head).eq('owner_id', myId).eq('kind', 'list')),
    countOf(sb().from('posts').select('id', head).eq('author_id', myId).in('kind', [...CLASSIC_POST_KINDS])),
  ]);
  return counts.some((n) => n > 0);
}

interface VoteRow { post_id: string; voter_id: string; envelope: Envelope; created_at: string }
// Same header and subkey as v1 lib/social/polls.ts (tag v1-classic).
const voteHeader = (postId: string, voterId: string, isPublic: boolean): EnvelopeHeader =>
  ({ v: 1, type: 'poll_vote', id: postId, author: voterId, wall: postId, audience: isPublic ? 'public' : 'self' });

function readVote(post: PostRow, r: VoteRow): string | null {
  const voter = people.get(r.voter_id);
  if (!voter) return null;
  try {
    const signPub = b64u.decode(voter.sign_pub);
    let v: { choice?: unknown };
    if (post.is_public) {
      v = openEnvelope<{ choice?: unknown }>({ header: voteHeader(post.id, r.voter_id, true), envelope: r.envelope, signPub });
    } else {
      const key = postContentKey(post);
      if (!key) return null;
      v = openWithContentKey<{ choice?: unknown }>({
        header: voteHeader(post.id, r.voter_id, false), envelope: r.envelope, contentKey: deriveSubkey(key, 'vote', r.voter_id), signPub,
      });
    }
    return typeof v.choice === 'string' && v.choice.trim() ? v.choice.trim().slice(0, 80) : null;
  } catch { return null; }
}

const sameOption = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function collectClassic(myId: string): Promise<ClassicData> {
  let skipped = 0;
  const problems: { what: string; why: string }[] = [];
  /** A part that fails (e.g. its table is already gone) is reported and left empty. */
  async function part<T>(what: string, fn: () => Promise<T>, empty: T): Promise<T> {
    try { return await fn(); } catch (e) { problems.push({ what: `classic.${what}`, why: (e as Error).message }); return empty; }
  }
  await keyring.load().catch(() => undefined);
  const vaultKey = deriveVaultKey(amk());
  const utf8 = new TextDecoder();

  // Pokes ------------------------------------------------------------------------------------------------
  const pokeRows = await part('pokes', () => all<{ from_id: string; to_id: string; created_at: string }>((a, b) =>
    sb().from('pokes').select('*').or(`from_id.eq.${myId},to_id.eq.${myId}`).order('created_at').range(a, b)), []);
  await people.ensure(pokeRows.flatMap((r) => [r.from_id, r.to_id]));
  const pokes: ClassicFiles['pokes.json'] = pokeRows.map((r) => ({
    direction: r.from_id === myId ? 'sent' : 'received', who: nameOf(r.from_id === myId ? r.to_id : r.from_id), at: r.created_at,
  }));

  // Kithville --------------------------------------------------------------------------------------------
  const kithville = await part<ClassicFiles['kithville.json']>('kithville', async () => {
    const row = must(await sb().from('game_state').select('blob, version, updated_at').eq('user_id', myId).maybeSingle()) as
      { blob: string; version: number; updated_at: string } | null;
    let farm: Record<string, unknown> | null = null;
    if (row) {
      try { farm = JSON.parse(utf8.decode(decryptBlob(vaultKey, row.blob, `kithville/${myId}`))) as Record<string, unknown>; }
      catch { skipped++; }
    }
    const actions = must(await sb().from('game_actions').select('*').or(`from_id.eq.${myId},to_id.eq.${myId}`).order('created_at')) as
      { id: string; from_id: string; to_id: string; kind: 'help' | 'gift'; sealed: Sealed; created_at: string; claimed_at: string | null }[];
    if (!row && !actions.length) return null;
    await people.ensure(actions.flatMap((r) => [r.from_id, r.to_id]));
    const mine = identity();
    const gifts = actions.map((r) => {
      const base = { kind: r.kind, at: r.created_at, claimed_at: r.claimed_at };
      // Sent ones are sealed to the friend: only who and when.
      if (r.from_id === myId) return { ...base, direction: 'sent' as const, to: nameOf(r.to_id) };
      let content: unknown = null;
      const sender = people.get(r.from_id);
      try {
        if (!sender) throw new Error('unknown sender');
        content = JSON.parse(utf8.decode(openSealed({
          sealed: r.sealed, recipientKxPriv: mine.kxPriv, recipientKxPub: mine.kxPub,
          senderSignPub: b64u.decode(sender.sign_pub), context: `kithville/${r.kind}/${r.id}/${r.to_id}`,
        })));
      } catch { skipped++; }
      return { ...base, direction: 'received' as const, from: nameOf(r.from_id), content };
    });
    const xp = typeof farm?.xp === 'number' ? farm.xp : null;
    return {
      saved_at: row?.updated_at ?? null, version: row?.version ?? null,
      level: xp === null ? null : 1 + Math.floor(Math.sqrt(xp / 12)), coins: farm?.coins ?? null, xp,
      farm, gifts_and_help: gifts,
    };
  }, null);

  // Pages ------------------------------------------------------------------------------------------------
  const pages = await part<ClassicFiles['pages.json']>('pages', async () => {
    const own = must(await sb().from('pages').select('*').eq('owner_id', myId).order('created_at')) as
      { id: string; name: string; category: string; about: string | null; created_at: string }[];
    const postRows = own.length ? (must(await sb().rpc('classic_page_posts')) as PostRow[]) : [];
    await preparePosts(postRows);
    const created: ClassicFiles['pages.json']['created'] = [];
    for (const p of own) {
      const likes = Number(must(await sb().rpc('page_like_count', { page: p.id }))) || 0;
      const posts = postRows.filter((r) => r.page_id === p.id).map((r) => {
        const d = readPost(r);
        if (!d.ok) skipped++;
        return { id: r.id, created_at: r.created_at, kind: r.kind, author: nameOf(r.author_id), content: d.ok ? d.value : null, status: d.ok ? 'ok' : d.reason };
      });
      created.push({ ...p, likes, posts });
    }
    const liked = must(await sb().rpc('classic_liked_pages')) as ClassicFiles['pages.json']['liked'];
    return { created, liked };
  }, { created: [], liked: [] });

  // My check-ins, life events, questions and Kithville posts -----------------------------------------------
  const classicPosts = await part('posts', () => all<Row<PostRow>>((a, b) => sb().from('posts').select('*').eq('author_id', myId)
    .in('kind', [...CLASSIC_POST_KINDS]).order('created_at').range(a, b)), []);
  await preparePosts(classicPosts);
  const posts: ClassicFiles['posts.json'] = classicPosts.map((r) => {
    const d = readPost(r);
    if (!d.ok) skipped++;
    return {
      id: r.id, created_at: r.created_at, kind: r.kind,
      on_wall_of: r.wall_owner_id && r.wall_owner_id !== myId ? nameOf(r.wall_owner_id) : null,
      content: d.ok ? d.value : null, status: d.ok ? 'ok' : d.reason,
    };
  });

  // Questions: mine with their votes, and my answers to friends' questions ---------------------------------
  const questions = await part<ClassicFiles['questions.json']>('questions', async () => {
    const mine = classicPosts.filter((p) => p.kind === 'question');
    const asked: ClassicFiles['questions.json']['asked'] = [];
    for (const q of mine) {
      const d = readPost(q);
      const rows = must(await sb().from('poll_votes').select('*').eq('post_id', q.id)) as VoteRow[];
      await people.ensure(rows.map((v) => v.voter_id));
      const votes = rows.map((v) => ({ who: nameOf(v.voter_id), choice: readVote(q, v), at: v.created_at }));
      skipped += votes.filter((v) => v.choice === null).length;
      const question = d.ok ? d.value.question ?? null : null;
      const options = [...(question?.options ?? [])];
      for (const v of votes) if (v.choice && !options.some((o) => sameOption(o, v.choice!))) options.push(v.choice);
      asked.push({
        id: q.id, created_at: q.created_at, question: question?.text ?? null, votes,
        results: options.map((o) => ({ option: o, votes: votes.filter((v) => v.choice && sameOption(o, v.choice)).map((v) => v.who) })),
      });
    }
    const myVotes = (must(await sb().from('poll_votes').select('*').eq('voter_id', myId)) as VoteRow[])
      .filter((v) => !mine.some((q) => q.id === v.post_id));
    const parents: PostRow[] = [];
    for (let i = 0; i < myVotes.length; i += 100) {
      parents.push(...(must(await sb().from('posts').select('*').in('id', myVotes.slice(i, i + 100).map((v) => v.post_id))) as PostRow[]));
    }
    await preparePosts(parents);
    await people.ensure([myId]);
    const answered = myVotes.map((v) => {
      const q = parents.find((p) => p.id === v.post_id);
      const d = q ? readPost(q) : null;
      const choice = q ? readVote(q, v) : null;
      if (choice === null) skipped++;
      return { question_id: v.post_id, asked_by: q ? nameOf(q.author_id) : null, question: d?.ok ? d.value.question?.text ?? null : null, my_answer: choice, at: v.created_at };
    });
    return { asked, answered };
  }, { asked: [], answered: [] });

  // Friend lists -----------------------------------------------------------------------------------------
  const lists = await part<ClassicFiles['friend-lists.json']>('friend_lists', async () => {
    const rows = must(await sb().from('audiences').select('id, name_enc, created_at').eq('owner_id', myId).eq('kind', 'list').order('created_at')) as
      { id: string; name_enc: { b?: unknown } | null; created_at: string }[];
    if (!rows.length) return [];
    const mem = must(await sb().from('audience_members').select('audience_id, member_id, status').in('audience_id', rows.map((r) => r.id))) as
      { audience_id: string; member_id: string; status: string }[];
    await people.ensure(mem.map((m) => m.member_id));
    return rows.map((r) => {
      let name: string | null = null;
      try { if (typeof r.name_enc?.b === 'string') name = utf8.decode(decryptBlob(vaultKey, r.name_enc.b, `list-name/${myId}`)); } catch { skipped++; }
      return {
        id: r.id, name, created_at: r.created_at,
        members: mem.filter((m) => m.audience_id === r.id && m.status === 'active' && m.member_id !== myId).map((m) => nameOf(m.member_id)),
      };
    });
  }, []);

  const summary: ClassicSummary = {
    pokes: pokes.length, kithville: !!kithville, gifts: kithville?.gifts_and_help.length ?? 0,
    pages: pages.created.length, likedPages: pages.liked.length, pagePosts: pages.created.reduce((a, p) => a + p.posts.length, 0),
    questions: questions.asked.length, votes: questions.answered.length, lists: lists.length, posts: posts.length,
  };
  return {
    files: { 'pokes.json': pokes, 'kithville.json': kithville, 'pages.json': pages, 'questions.json': questions, 'friend-lists.json': lists, 'posts.json': posts },
    summary, skipped, problems,
  };
}

/** "Kithwall Classic data" on its own: a small ZIP with a readable page and the JSON files. */
export async function buildClassicExport(): Promise<{ blob: Blob; filename: string; summary: ClassicSummary }> {
  const s = getSession();
  if (s.status !== 'ready' || !s.profile) throw new Error('Unlock Kithwall first.');
  const c = await collectClassic(me());
  const generated = new Date();
  const files: Zippable = {};
  for (const [name, value] of Object.entries(c.files)) files[`data/${name}`] = strToU8(JSON.stringify(value, null, 2));
  if (c.problems.length) files['data/export-problems.json'] = strToU8(JSON.stringify(c.problems, null, 2));
  files['index.html'] = strToU8(renderClassicIndex(s.profile.username, generated, c));
  files['README.txt'] = strToU8(
    `Your Kithwall Classic data, exported ${generated.toISOString()}.\n\n` +
    'These are the parts of Kithwall Classic (the 2010-style Kithwall) that Kithwall 2 no longer shows: pokes,\n' +
    'Kithville, Pages, questions and their votes, friend lists, and your check-ins, life events and Kithville posts.\n' +
    'Everything else (posts, photos, messages, circles, events...) is in Settings > Your data > Download your data.\n\n' +
    'Everything here was decrypted on your own device. Keep this file safe: it is NOT encrypted.\n' +
    'Open index.html in a browser, or use the JSON files in data/.\n' +
    (c.skipped ? `\n${c.skipped} item(s) could not be decrypted or verified and are listed without content.\n` : ''));
  const zipped = zipSync(files, { level: 6 });
  return {
    blob: new Blob([zipped as BlobPart], { type: 'application/zip' }),
    filename: `kithwall-classic-${s.profile.username}-${generated.toISOString().slice(0, 10)}.zip`,
    summary: c.summary,
  };
}

function renderClassicIndex(username: string, generated: Date, c: ClassicData): string {
  const f = c.files;
  const text = (x: unknown) => {
    const v = x as PostPayload | null;
    const parts = [v?.text, v?.question?.text, v?.checkin ? `@ ${v.checkin.place}` : '', v?.lifeEvent?.title, v?.game?.text];
    return parts.filter(Boolean).join(' ');
  };
  const sec = (title: string, count: number, body: string) => `<section><h2>${esc(title)} <span class="n">${count}</span></h2>${body || '<p class="g">Nothing here.</p>'}</section>`;
  const k = f['kithville.json'];
  const undecrypted = '(could not be decrypted)';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kithwall Classic: @${esc(username)}</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:16px 16px 48px}
h1{font-size:26px;margin:8px 0}h2{font-size:18px;margin:28px 0 8px;padding-bottom:4px;border-bottom:1px solid #8884}.n{font-weight:400;opacity:.6}
.it{border-bottom:1px solid #8882;padding:8px 0}.g{opacity:.65;font-size:13px}</style></head><body>
<h1>Kithwall Classic</h1>
<p class="g">@${esc(username)} &middot; exported ${esc(generated.toUTCString())}.<br>Decrypted on your device; this copy is not encrypted.${c.skipped ? ` ${c.skipped} item(s) could not be decrypted.` : ''}</p>
${sec('Pokes', f['pokes.json'].length, f['pokes.json'].map((p) => `<div class="it">${p.direction === 'sent' ? 'You poked' : 'Poked by'} ${esc(p.who)} <span class="g">${esc(p.at)}</span></div>`).join(''))}
${sec('Kithville', k ? 1 : 0, k ? `<div class="it">Level ${esc(k.level ?? '?')} &middot; ${esc(k.coins ?? '?')} coins <span class="g">saved ${esc(k.saved_at ?? '')}</span></div>${k.gifts_and_help.map((a) => `<div class="it">${esc(a.kind)} ${a.direction === 'sent' ? `to ${esc(a.to)}` : `from ${esc(a.from)}`} <span class="g">${esc(a.at)}</span></div>`).join('')}` : '')}
${sec('Your Pages', f['pages.json'].created.length, f['pages.json'].created.map((p) => `<div class="it"><b>${esc(p.name)}</b> <span class="g">${esc(p.category)} &middot; ${p.likes} likes</span><div>${esc(p.about ?? '')}</div>${p.posts.map((x) => `<div class="g">${esc(x.created_at)}: ${esc(text(x.content))}</div>`).join('')}</div>`).join(''))}
${sec('Pages you liked', f['pages.json'].liked.length, f['pages.json'].liked.map((p) => `<div class="it">${esc(p.name)} <span class="g">${esc(p.category)}</span></div>`).join(''))}
${sec('Your questions', f['questions.json'].asked.length, f['questions.json'].asked.map((q) => `<div class="it"><b>${esc(q.question ?? undecrypted)}</b>${q.results.map((r) => `<div>${esc(r.option)}: ${r.votes.length} <span class="g">${esc(r.votes.join(', '))}</span></div>`).join('')}</div>`).join(''))}
${sec('Your answers', f['questions.json'].answered.length, f['questions.json'].answered.map((q) => `<div class="it">${esc(q.question ?? undecrypted)} <span class="g">${esc(q.asked_by ?? '')}</span><div>${esc(q.my_answer ?? '')}</div></div>`).join(''))}
${sec('Friend lists', f['friend-lists.json'].length, f['friend-lists.json'].map((l) => `<div class="it"><b>${esc(l.name ?? undecrypted)}</b> <span class="g">${esc(l.members.join(', '))}</span></div>`).join(''))}
${sec('Check-ins, life events, questions and Kithville posts', f['posts.json'].length, f['posts.json'].map((p) => `<div class="it">${esc(text(p.content))} <span class="g">${esc(p.kind)} &middot; ${esc(p.created_at)}</span></div>`).join(''))}
</body></html>`;
}
