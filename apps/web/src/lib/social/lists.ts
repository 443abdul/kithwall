'use client';
// Friend lists ("Close Friends", "Family" …): custom audiences with their own key (spec §3.7).
// The list name is encrypted with my vault key, so only I can read it; members only receive
// the list's audience key (delivered by keyring.deliverPending) and never learn the name.
import { decryptBlob, deriveVaultKey, encryptBlob } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { amk, me } from '../keys/session';
import { keyring } from '../keys/keyring';
import type { AudienceRow } from '../types';

export interface FriendList { id: string; name: string; epoch: number; members: string[]; createdAt: string }

const MAX_NAME = 60;
const aad = () => `list-name/${me()}`;

function encName(name: string) {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) throw new Error('Please give the list a name.');
  return { v: 1, b: encryptBlob(deriveVaultKey(amk()), new TextEncoder().encode(clean), aad()) };
}

function decName(enc: unknown): string {
  try {
    const b = (enc as { b?: unknown } | null)?.b;
    if (typeof b !== 'string') return 'Untitled list';
    return new TextDecoder().decode(decryptBlob(deriveVaultKey(amk()), b, aad()));
  } catch { return 'Untitled list'; }
}

export async function myLists(): Promise<FriendList[]> {
  const rows = must(await sb().from('audiences').select('*').eq('owner_id', me()).eq('kind', 'list').order('created_at')) as AudienceRow[];
  if (!rows.length) return [];
  const mem = must(await sb().from('audience_members').select('audience_id, member_id, status')
    .in('audience_id', rows.map((r) => r.id))) as { audience_id: string; member_id: string; status: string }[];
  return rows.map((r) => ({
    id: r.id, name: decName(r.name_enc), epoch: r.current_epoch, createdAt: r.created_at,
    members: mem.filter((m) => m.audience_id === r.id && m.status === 'active' && m.member_id !== me()).map((m) => m.member_id),
  }));
}

export async function createList(name: string, members: string[] = []): Promise<FriendList> {
  const row = await keyring.createAudience('list', encName(name));
  if (members.length) {
    must(await sb().from('audience_members').insert(members.map((m) => ({ audience_id: row.id, member_id: m, status: 'active', role: 'member' }))));
    await keyring.deliverPending();
  }
  return { id: row.id, name: name.trim(), epoch: row.current_epoch, members, createdAt: row.created_at };
}

export async function renameList(id: string, name: string) {
  must(await sb().from('audiences').update({ name_enc: encName(name) }).eq('id', id).eq('owner_id', me()));
}

export async function addToList(id: string, memberId: string) {
  const r = await sb().from('audience_members').insert({ audience_id: id, member_id: memberId, status: 'active', role: 'member' });
  if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
  await keyring.deliverPending();
}

/** Remove someone and rotate the list key so they can't read anything shared with it afterwards. */
export async function removeFromList(id: string, memberId: string) {
  must(await sb().from('audience_members').delete().match({ audience_id: id, member_id: memberId }));
  await keyring.rotate(id);
}

/** Deleting a list also deletes the posts that were shared only with it. */
export async function deleteList(id: string) {
  must(await sb().from('audiences').delete().eq('id', id).eq('owner_id', me()).eq('kind', 'list'));
}
