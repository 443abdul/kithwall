'use client';
// Pages are public by nature (name, category, about and wall posts are NOT encrypted) and only
// exist while the operator has enabled the Public audience. Which pages you like is private:
// like rows are readable only by you, and the total comes from page_like_count().
import { sb, must } from './supabase';
import { me } from './keys/session';
import { createPost, preparePosts } from './content';
import type { PostRow } from './types';

export interface PageRow { id: string; owner_id: string; name: string; category: string; about: string | null; created_at: string }

export const PAGE_CATEGORIES = [
  'Local Business', 'Company', 'Brand or Product', 'Artist, Band or Public Figure', 'Entertainment',
  'Cause or Community', 'Book', 'Movie', 'TV Show', 'Music', 'Sports Team', 'Website', 'Food & Drink', 'Other',
];

export async function searchPages(q: string, limit = 30): Promise<PageRow[]> {
  let query = sb().from('pages').select('*').order('created_at', { ascending: false }).limit(limit);
  const term = q.trim();
  if (term) query = query.ilike('name', `%${term.replace(/[%_\\]/g, '\\$&')}%`);
  return must(await query) as PageRow[];
}

export async function getPage(id: string): Promise<PageRow | null> {
  const { data, error } = await sb().from('pages').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as PageRow | null;
}

export async function myLikedPageIds(): Promise<string[]> {
  const rows = must(await sb().from('page_likes').select('page_id').eq('user_id', me())) as { page_id: string }[];
  return rows.map((r) => r.page_id);
}

export async function myLikedPages(): Promise<PageRow[]> {
  const ids = await myLikedPageIds();
  if (!ids.length) return [];
  return must(await sb().from('pages').select('*').in('id', ids)) as PageRow[];
}

export async function myPages(): Promise<PageRow[]> {
  return must(await sb().from('pages').select('*').eq('owner_id', me()).order('created_at', { ascending: false })) as PageRow[];
}

export async function likeCount(id: string): Promise<number> {
  const n = must(await sb().rpc('page_like_count', { page: id })) as number | string;
  return Number(n) || 0;
}

export async function setPageLike(id: string, on: boolean) {
  if (on) {
    const r = await sb().from('page_likes').insert({ page_id: id, user_id: me() });
    if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
  } else {
    must(await sb().from('page_likes').delete().match({ page_id: id, user_id: me() }));
  }
}

export interface PageInput { name: string; category: string; about: string }

function clean(p: PageInput): PageInput {
  return { name: p.name.trim().slice(0, 120), category: p.category.trim().slice(0, 60), about: p.about.trim().slice(0, 2000) };
}

export async function createPage(p: PageInput): Promise<string> {
  const id = crypto.randomUUID();
  must(await sb().from('pages').insert({ id, owner_id: me(), ...clean(p) }));
  return id;
}

export async function updatePage(id: string, p: PageInput) {
  must(await sb().from('pages').update(clean(p)).eq('id', id));
}

export async function deletePage(id: string) {
  must(await sb().from('pages').delete().eq('id', id));
}

/** Page wall: public posts written by the page owner. */
export async function pagePosts(page: PageRow, before?: string): Promise<PostRow[]> {
  let q = sb().from('posts').select('*').eq('page_id', page.id).eq('author_id', page.owner_id)
    .order('created_at', { ascending: false }).limit(20);
  if (before) q = q.lt('created_at', before);
  const rows = must(await q) as PostRow[];
  await preparePosts(rows);
  return rows;
}

export async function postToPage(page: PageRow, text: string): Promise<PostRow> {
  return createPost({ kind: 'status', payload: { text }, pageId: page.id, audience: { kind: 'public' } });
}
