'use client';
// "Download your data" (spec §5 Export; docs/v2/03-transparency.md §4): everything I own or take part in
// that I can read is fetched, verified and decrypted ON THIS DEVICE, then zipped (fflate). Nothing
// decrypted leaves the browser except as the file the user saves.
//
// kithwall-<handle>-<date>.zip
//   index.html                       readable overview (open in any browser, no network)
//   README.txt
//   data/*.json                      profile, connections, posts, notes, comments, reactions, albums,
//                                    photos, stories, circles, events, messages, settings, legacy contact,
//                                    and what-kithwall-knows.json (the server's live inventory, /you/privacy-report)
//   media/albums/<album>/<id>.jpg    decrypted photos (largest size)
//   media/posts/<post id>-<n>.jpg    photos attached to my posts
//   media/stories/<story id>.jpg     my live stories
//   media/messages/<chat>/<id>-<n>   images I can read in my chats
// Videos and files bigger than MAX_FILE stay in Kithwall (listed with "file": null, "skipped": "too_large").
import { b64u, decryptBlob, decryptFile, deriveVaultKey } from '@kithwall/crypto';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { sb, must } from './supabase';
import { amk, getSession, me } from './keys/session';
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
import { exportLegacy } from './legacy/legacy';
import type { CommentRow, FileRef, LikeRow, MessageRow, PostRow } from './types';

export type ExportStep =
  | 'profile' | 'posts' | 'comments' | 'albums' | 'photos' | 'stories' | 'circles' | 'events'
  | 'messages' | 'settings' | 'inventory' | 'packaging';
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
    id: myId, username: s.profile.username, created_at: s.profile.created_at,
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
  // Legacy contact: my choice and my note (opened from my own sealed copy), and who chose me.
  let legacy: unknown = null;
  try { legacy = await exportLegacy(); } catch (e) { skipped++; problems.push({ what: 'legacy', why: (e as Error).message }); }

  // The server's own inventory about me (the same as /you/privacy-report) ------------------------------------------------
  progress('inventory');
  let inventory: unknown = null;
  try { inventory = await fetchTransparencyReport(); } catch (e) { inventory = { error: 'unavailable' }; problems.push({ what: 'inventory', why: (e as Error).message }); }

  // Assemble ------------------------------------------------------------------------------------------------------
  progress('packaging');
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
  files['data/legacy.json'] = json(legacy);
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
    (tooLarge ? `\n${tooLarge} file(s) larger than ${MAX_FILE / 1048576} MB (mostly videos) were left out; download them from Kithwall.\n` : ''));

  const zipped = zipSync(files, { level: 6 });
  summary.bytes = zipped.byteLength;
  const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
  return { blob, filename: `kithwall-${s.profile.username}-${generated.toISOString().slice(0, 10)}.zip`, summary };
}

type Content = { text?: string; note?: { title?: string; body?: string }; link?: { url?: string } } | null;

function renderIndex(d: {
  profile: { username: string; info: unknown };
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
<p class="g">@${esc(d.profile.username)} &middot; exported ${esc(d.generated.toUTCString())}.<br>Decrypted on your device; this copy is not encrypted.${d.summary.skipped ? ` ${d.summary.skipped} item(s) could not be decrypted.` : ''}${d.summary.tooLarge ? ` ${d.summary.tooLarge} large file(s) were left out.` : ''}</p>
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
