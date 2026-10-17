'use client';
// "Download Your Information" (spec §5 Export): everything I own that I can read is fetched,
// verified and decrypted ON THIS DEVICE, then zipped (fflate). Nothing decrypted leaves the browser
// except as the file the user saves.
import { b64u, decryptFile } from '@kithwall/crypto';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { sb, must } from './supabase';
import { getSession, me } from './keys/session';
import { people } from './people';
import { myFriendIds } from './friends';
import { postContentKey, preparePosts, readComment, readPost } from './content';
import { photoContentKey, readAlbum, readPhoto, type AlbumRow, type PhotoRow } from './photos';
import { listConversations, readMessage, fetchMessages, type ConversationSummary } from './messages';
import type { CommentRow, FileRef, PostRow } from './types';

export type Progress = (step: string, done?: number, total?: number) => void;

const PAGE = 500;

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

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'album';
const nameOf = (id: string) => { const p = people.person(id); return p ? `${p.name} (@${p.username})` : id; };

export interface ExportSummary { posts: number; comments: number; photos: number; messages: number; skipped: number; bytes: number }

export async function buildExport(progress: Progress = () => undefined): Promise<{ blob: Blob; filename: string; summary: ExportSummary }> {
  const s = getSession();
  if (s.status !== 'ready' || !s.profile) throw new Error('Unlock Kithwall first.');
  const myId = me();
  let skipped = 0;
  const files: Zippable = {};

  // Profile & friends --------------------------------------------------------------------
  progress('Your profile');
  await people.refreshInfo(myId);
  const info = people.person(myId)?.info ?? null;
  const friendIds = await myFriendIds();
  await people.ensure(friendIds);
  const friends = friendIds.map((id) => { const p = people.person(id); return { id, username: p?.username, name: p?.name }; });
  const profile = { username: s.profile.username, email: s.email, created_at: s.profile.created_at, directory_name: s.profile.display_name_public, info };

  // Posts (mine, and others' posts on my wall) -------------------------------------------------
  progress('Posts');
  const postRows = await all<PostRow>((a, b) => sb().from('posts').select('*').or(`author_id.eq.${myId},wall_owner_id.eq.${myId}`).order('created_at').range(a, b));
  await preparePosts(postRows);
  const posts = postRows.map((r) => {
    const d = readPost(r);
    if (!d.ok) skipped++;
    return { id: r.id, created_at: r.created_at, kind: r.kind, author: nameOf(r.author_id), audience: r.is_public ? 'public' : r.audience_id, content: d.ok ? d.value : null, status: d.ok ? 'ok' : d.reason };
  });

  // My comments --------------------------------------------------------------------------------
  progress('Comments');
  const commentRows = await all<CommentRow>((a, b) => sb().from('comments').select('*').eq('author_id', myId).order('created_at').range(a, b));
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
    return { id: c.id, created_at: c.created_at, on_post: c.post_id, on_photo: c.photo_id, text: d.ok ? d.value.text : null, status: d.ok ? 'ok' : d.reason };
  });

  // Albums & photos (with decrypted image files) ----------------------------------------------------
  progress('Photo albums');
  const albumRows = await all<AlbumRow>((a, b) => sb().from('albums').select('*').eq('owner_id', myId).order('created_at').range(a, b));
  const photoRows = await all<PhotoRow>((a, b) => sb().from('photos').select('*').eq('owner_id', myId).order('created_at').range(a, b));
  const albums = albumRows.map((a) => {
    const d = readAlbum(a);
    if (!d.ok) skipped++;
    return { id: a.id, created_at: a.created_at, name: d.ok ? d.value.name : null, description: d.ok ? d.value.description : null, folder: `photos/${slug(d.ok ? d.value.name : a.id)}-${a.id.slice(0, 8)}` };
  });
  const photos: { id: string; album: string; created_at: string; caption?: string; tags: string[]; file: string | null }[] = [];
  let n = 0;
  for (const p of photoRows) {
    progress('Photos', ++n, photoRows.length);
    const d = readPhoto(p);
    const album = albums.find((a) => a.id === p.album_id);
    if (!d.ok) { skipped++; continue; }
    const path = `${album?.folder ?? 'photos/other'}/${p.id}.jpg`;
    let file: string | null = path;
    try { files[path] = [await fileBytes(d.value.files.big), { level: 0 }]; } catch { file = null; skipped++; }
    await people.ensure(d.value.tags.map((t) => t.id));
    photos.push({ id: p.id, album: album?.name ?? '', created_at: p.created_at, caption: d.value.caption, tags: d.value.tags.map((t) => nameOf(t.id)), file });
  }

  // Messages in conversations I'm part of --------------------------------------------------------------
  progress('Messages');
  const convs: ConversationSummary[] = await listConversations(1000);
  const conversations: { id: string; with: string[]; messages: { at: string; from: string; text: string | null; status: string }[] }[] = [];
  let ci = 0;
  for (const c of convs) {
    progress('Messages', ++ci, convs.length);
    const msgs: { at: string; from: string; text: string | null; status: string }[] = [];
    let before: string | undefined;
    for (;;) {
      const rows = await fetchMessages(c, before, 50);
      if (!rows.length) break;
      for (const r of rows) {
        const d = readMessage(c, r);
        if (!d.ok) skipped++;
        msgs.push({ at: r.created_at, from: nameOf(r.sender_id), text: d.ok ? d.value.text : null, status: d.ok ? 'ok' : d.reason });
      }
      before = rows[0]!.created_at;
      if (rows.length < 50) break;
    }
    msgs.sort((a, b) => a.at.localeCompare(b.at));
    conversations.push({ id: c.id, with: c.members.filter((m) => m !== myId).map(nameOf), messages: msgs });
  }

  // Assemble ---------------------------------------------------------------------------------------------
  progress('Packaging');
  const json = (o: unknown) => strToU8(JSON.stringify(o, null, 2));
  files['data/profile.json'] = json(profile);
  files['data/friends.json'] = json(friends);
  files['data/posts.json'] = json(posts);
  files['data/comments.json'] = json(comments);
  files['data/albums.json'] = json(albums);
  files['data/photos.json'] = json(photos);
  files['data/messages.json'] = json(conversations);
  const generated = new Date();
  files['index.html'] = strToU8(renderIndex({ profile, friends, posts, photos, conversations, generated, skipped }));
  files['README.txt'] = strToU8(
    `Your Kithwall information, exported ${generated.toISOString()}.\n\n` +
    `Everything here was decrypted on your own device. Keep this file safe: it is NOT encrypted.\n` +
    `Open index.html in a browser, or use the JSON files in data/.\n` +
    (skipped ? `\n${skipped} item(s) could not be decrypted or verified and are listed without content.\n` : ''));

  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped as BlobPart], { type: 'application/zip' });
  return {
    blob, filename: `kithwall-${s.profile.username}-${generated.toISOString().slice(0, 10)}.zip`,
    summary: { posts: posts.length, comments: comments.length, photos: photos.length, messages: conversations.reduce((a, c) => a + c.messages.length, 0), skipped, bytes: zipped.byteLength },
  };
}

function renderIndex(d: {
  profile: { username: string; email: string | null; info: unknown };
  friends: { username?: string; name?: string }[];
  posts: { created_at: string; author: string; content: unknown; status: string }[];
  photos: { album: string; caption?: string; file: string | null }[];
  conversations: { with: string[]; messages: { at: string; from: string; text: string | null }[] }[];
  generated: Date; skipped: number;
}): string {
  const info = (d.profile.info ?? {}) as { name?: string };
  const postText = (c: unknown) => { const x = c as { text?: string; note?: { title?: string; body?: string }; link?: { url?: string } } | null; return x?.text ?? x?.note?.title ?? x?.link?.url ?? ''; };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kithwall — ${esc(info.name ?? d.profile.username)}</title>
<style>body{font:13px "lucida grande",tahoma,verdana,arial,sans-serif;color:#333;max-width:760px;margin:0 auto;padding:0 12px 40px}
h1{background:#3b5998;color:#fff;font-size:20px;padding:10px 12px;margin:0 -12px 16px}h2{font-size:14px;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:24px;color:#3b5998}
.it{border-bottom:1px solid #eee;padding:6px 0}.g{color:#777;font-size:11px}img{max-width:200px;border:1px solid #ccc;margin:4px}</style></head><body>
<h1>kithwall &mdash; ${esc(info.name ?? d.profile.username)}</h1>
<p class="g">Exported ${esc(d.generated.toUTCString())}. Decrypted on your device; this copy is not encrypted.${d.skipped ? ` ${d.skipped} item(s) could not be decrypted.` : ''}</p>
<h2>Profile</h2><div class="it">@${esc(d.profile.username)} &middot; ${esc(d.profile.email)}</div>
<h2>Friends (${d.friends.length})</h2>${d.friends.map((f) => `<div class="it">${esc(f.name)} <span class="g">@${esc(f.username)}</span></div>`).join('')}
<h2>Posts (${d.posts.length})</h2>${d.posts.map((p) => `<div class="it"><b>${esc(p.author)}</b> ${esc(postText(p.content))}${p.status !== 'ok' ? ' <span class="g">(could not be decrypted)</span>' : ''}<div class="g">${esc(p.created_at)}</div></div>`).join('')}
<h2>Photos (${d.photos.length})</h2>${d.photos.map((p) => (p.file ? `<a href="${esc(p.file)}"><img src="${esc(p.file)}" alt="${esc(p.caption ?? p.album)}"></a>` : '')).join('')}
<h2>Messages (${d.conversations.length} conversations)</h2>${d.conversations.map((c) => `<div class="it"><b>With ${esc(c.with.join(', ') || 'only you')}</b>${c.messages.map((m) => `<div><span class="g">${esc(m.at)}</span> <b>${esc(m.from)}:</b> ${esc(m.text ?? '(could not be decrypted)')}</div>`).join('')}</div>`).join('')}
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
