'use client';
// Groups (Oct 2010 "new Groups"): Closed and Secret groups are end-to-end encrypted to their
// members (an audience with its own epoch keys); Open groups are public and only exist while the
// operator has enabled the Public audience. Also holds the container helpers shared with events:
// sealing/opening a container envelope, delivering epoch keys to members, and rotation.
import { b64u, openEnvelope, seal, sealEnvelope, type Envelope, type EnvelopeHeader } from '@kithwall/crypto';
import { sb, must } from './supabase';
import { identity, me } from './keys/session';
import { keyring, KeyWaitingError } from './keys/keyring';
import { people } from './people';
import { notify } from './friends';
import { preparePosts, type Decrypted } from './content';
import type { AudienceRow, PostRow } from './types';

// ---------------------------------------------------------------------------------------
// Shared container plumbing (groups + events)

export interface MemberRow {
  audience_id: string; member_id: string; role: 'admin' | 'member'; status: 'active' | 'invited' | 'requested';
  rsvp: 'yes' | 'maybe' | 'no' | null; invited_by: string | null; last_read_at: string | null; created_at: string;
}

export interface ContainerRow {
  id: string; audience_id: string; envelope: Envelope | null; envelope_by: string | null; envelope_epoch: number | null;
}

export function containerHeader(type: 'group' | 'event', id: string, author: string, aud: string, epoch: number | null): EnvelopeHeader {
  return { v: 1, type, id, author, audience: epoch === null ? 'public' : { id: aud, epoch } };
}

/** Seal container metadata under the audience's current key (or as a signed public body). */
export async function sealContainer<T>(type: 'group' | 'event', id: string, aud: string, payload: T, isPublic: boolean): Promise<{ envelope: Envelope; epoch: number | null }> {
  if (isPublic) {
    return { envelope: sealEnvelope({ header: containerHeader(type, id, me(), aud, null), payload, signPriv: identity().signPriv }), epoch: null };
  }
  const { key, epoch } = await keyring.current(aud);
  return { envelope: sealEnvelope({ header: containerHeader(type, id, me(), aud, epoch), payload, audienceKey: key, signPriv: identity().signPriv }), epoch };
}

/**
 * Verify (signature first) and decrypt container metadata. `signers`, when known, is the set of
 * people allowed to have written it (creator + admins); anything else is "unverified".
 */
export function openContainer<T>(type: 'group' | 'event', row: ContainerRow, envelope: Envelope | null, isPublic: boolean, signers?: Set<string>): Decrypted<T> {
  if (!envelope || !row.envelope_by) return { ok: false, reason: 'unverified' };
  if (signers && !signers.has(row.envelope_by)) return { ok: false, reason: 'unverified' };
  const author = people.get(row.envelope_by);
  if (!author) return { ok: false, reason: 'waiting' };
  let key: Uint8Array | undefined;
  if (!isPublic) {
    if (!row.envelope_epoch) return { ok: false, reason: 'unverified' };
    key = keyring.get(row.audience_id, row.envelope_epoch) ?? undefined;
    if (!key) return { ok: false, reason: 'waiting' };
  }
  try {
    const value = openEnvelope<T>({
      header: containerHeader(type, row.id, row.envelope_by, row.audience_id, isPublic ? null : row.envelope_epoch),
      envelope, audienceKey: key, signPub: b64u.decode(author.sign_pub),
    });
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'unverified' };
  }
}

const keyCtx = (aud: string, epoch: number, recipient: string) => `audience-key/${aud}/${epoch}/${recipient}`;

/** Seal one epoch key to one person (same format the keyring reads). Duplicates are ignored. */
async function sealKeyTo(aud: string, epoch: number, recipient: string, kxPub: string, key: Uint8Array) {
  const sealed = seal({ recipientKxPub: b64u.decode(kxPub), senderSignPriv: identity().signPriv, context: keyCtx(aud, epoch, recipient), plaintext: key });
  const res = await sb().from('audience_keys').insert({ audience_id: aud, epoch, recipient_id: recipient, sealed_by: me(), sealed });
  if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
}

/**
 * Admins: deliver every epoch key we hold to members (active or invited) who lack it, so new
 * members can read the history. Returns how many keys were delivered.
 */
export async function deliverMemberKeys(aud: string): Promise<number> {
  const { data, error } = await sb().rpc('community_key_gaps', { aud });
  if (error) return 0;
  const gaps = (data ?? []) as { recipient_id: string; epoch: number; recipient_kx_pub: string }[];
  let n = 0;
  for (const g of gaps) {
    const key = keyring.get(aud, g.epoch);
    if (!key) continue;
    try { await sealKeyTo(aud, g.epoch, g.recipient_id, g.recipient_kx_pub, key); n++; } catch { /* not entitled any more */ }
  }
  return n;
}

/**
 * Advance the audience to a new epoch (compare-and-swap, so two admins never mint two keys for
 * the same epoch), keep a copy for ourselves and deliver it to the remaining members.
 * Returns true if we rotated.
 */
export async function rotateAudience(aud: string): Promise<boolean> {
  const row = must(await sb().from('audiences').select('*').eq('id', aud).single()) as AudienceRow;
  // Make sure we hold the current key first (so history stays readable for us).
  await keyring.current(aud).catch(() => undefined);
  const res = await sb().from('audiences').update({ current_epoch: row.current_epoch + 1 })
    .eq('id', aud).eq('current_epoch', row.current_epoch).select();
  if (res.error) throw new Error(res.error.message);
  const next = (res.data as AudienceRow[])[0];
  if (!next) return false; // someone else rotated first; we'll receive their key
  await keyring.ensureOwn(next);
  await keyring.deliverPending().catch(() => undefined);
  await deliverMemberKeys(aud).catch(() => undefined);
  return true;
}

/** Rotation check run on an admin's device: rotate if a non-member holds the current key. */
export async function rotateIfNeeded(aud: string): Promise<boolean> {
  const { data, error } = await sb().rpc('community_needs_rotation', { aud });
  if (error || data !== true) return false;
  return rotateAudience(aud);
}

export async function membersOf(aud: string): Promise<MemberRow[]> {
  const rows = must(await sb().from('audience_members').select('*').eq('audience_id', aud).order('created_at')) as MemberRow[];
  await people.ensure(rows.map((r) => r.member_id));
  return rows;
}

export async function myMemberships(): Promise<MemberRow[]> {
  return must(await sb().from('audience_members').select('*').eq('member_id', me())) as MemberRow[];
}

/** Notify with a preview sealed to the recipient (never stored in the clear). */
export async function notifyWith(recipient: string, type: string, objectKind: string, objectId: string, previewText?: string) {
  await notify(recipient, type, objectKind, objectId, previewText?.slice(0, 200)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------
// Groups

export type GroupPrivacy = 'open' | 'closed' | 'secret';

export interface GroupRow extends ContainerRow {
  creator_id: string; privacy: GroupPrivacy; name_public: string | null; created_at: string;
}

export interface GroupInfo { name: string; description?: string; color?: string }

export function readGroup(g: GroupRow, signers?: Set<string>): Decrypted<GroupInfo> {
  const res = openContainer<GroupInfo>('group', g, g.envelope, g.privacy === 'open', signers);
  if (res.ok && g.privacy === 'open' && g.name_public) return { ok: true, value: { ...res.value, name: g.name_public } };
  return res;
}

/** Best label for a group we may not be able to decrypt yet. */
export function groupName(g: GroupRow, d: Decrypted<GroupInfo>): string {
  if (d.ok) return d.value.name;
  if (g.name_public) return g.name_public;
  return d.reason === 'waiting' ? 'Private group (waiting for a key)' : 'Private group';
}

export async function listGroups(): Promise<GroupRow[]> {
  const rows = must(await sb().from('groups').select('*').order('created_at', { ascending: false })) as GroupRow[];
  await people.ensure(rows.flatMap((r) => [r.creator_id, r.envelope_by ?? '']).filter(Boolean));
  return rows;
}

export async function getGroup(id: string): Promise<GroupRow | null> {
  const { data, error } = await sb().from('groups').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  const g = data as GroupRow | null;
  if (g) await people.ensure([g.creator_id, g.envelope_by ?? ''].filter(Boolean));
  return g;
}

export async function createGroup(args: { info: GroupInfo; privacy: GroupPrivacy; invite: string[] }): Promise<string> {
  const id = crypto.randomUUID();
  const aud = await keyring.createAudience('group');
  try {
    must(await sb().from('audience_members').insert({ audience_id: aud.id, member_id: me(), role: 'admin', status: 'active' }));
    const isOpen = args.privacy === 'open';
    const { envelope, epoch } = await sealContainer('group', id, aud.id, args.info, isOpen);
    must(await sb().from('groups').insert({
      id, creator_id: me(), audience_id: aud.id, privacy: args.privacy,
      name_public: isOpen ? args.info.name : null, envelope, envelope_epoch: epoch,
    }));
  } catch (e) {
    await sb().from('audiences').delete().eq('id', aud.id);
    throw e;
  }
  if (args.invite.length) await inviteToGroup({ id, audience_id: aud.id }, args.invite, args.info.name);
  return id;
}

export async function updateGroup(g: GroupRow, info: GroupInfo, privacy?: GroupPrivacy): Promise<void> {
  const isOpen = g.privacy === 'open';
  const { envelope, epoch } = await sealContainer('group', g.id, g.audience_id, info, isOpen);
  must(await sb().from('groups').update({
    envelope, envelope_epoch: epoch, ...(isOpen ? { name_public: info.name } : {}),
    ...(privacy && privacy !== 'open' && !isOpen ? { privacy } : {}),
  }).eq('id', g.id));
}

/** Re-seal the group's metadata under the current epoch (after a rotation). */
export async function resealGroup(g: GroupRow, info: GroupInfo | null) {
  if (!info || g.privacy === 'open') return;
  await updateGroup(g, info);
}

/**
 * Invite friends. Admins seal the keys right away so the invitee can read the group's name;
 * members' invitations get keys from an admin's device once accepted.
 */
export async function inviteToGroup(g: { id: string; audience_id: string }, friendIds: string[], groupNameText: string): Promise<number> {
  let n = 0;
  for (const f of friendIds) {
    const r = await sb().from('audience_members').insert({ audience_id: g.audience_id, member_id: f, role: 'member', status: 'invited' });
    if (r.error && r.error.code !== '23505') throw new Error(r.error.message);
    if (!r.error) {
      n++;
      await notifyWith(f, 'group_invite', 'group', g.id, `invited you to join the group ${groupNameText}`);
    }
  }
  await deliverMemberKeys(g.audience_id).catch(() => undefined);
  return n;
}

export async function acceptInvite(aud: string) {
  must(await sb().from('audience_members').update({ status: 'active' }).eq('audience_id', aud).eq('member_id', me()));
  await keyring.load().catch(() => undefined);
}

/** Decline an invitation, cancel a request, or leave. */
export async function leave(aud: string) {
  must(await sb().from('audience_members').delete().eq('audience_id', aud).eq('member_id', me()));
}

export async function setRole(aud: string, memberId: string, role: 'admin' | 'member') {
  must(await sb().from('audience_members').update({ role }).eq('audience_id', aud).eq('member_id', memberId));
  if (role === 'admin') await deliverMemberKeys(aud).catch(() => undefined);
}

/** Remove a member (or reject a request) and rotate so they can't read anything new. */
export async function removeMember(g: GroupRow, memberId: string, info: GroupInfo | null) {
  must(await sb().from('audience_members').delete().eq('audience_id', g.audience_id).eq('member_id', memberId));
  if (g.privacy !== 'open' && (await rotateIfNeeded(g.audience_id))) {
    const fresh = await getGroup(g.id);
    if (fresh) await resealGroup(fresh, info);
  }
}

export async function deleteGroup(g: GroupRow) {
  // Deleting the audience cascades to the group, its posts, memberships and keys.
  must(await sb().from('audiences').delete().eq('id', g.audience_id));
}

// ---------------------------------------------------------------------------------------
// Group wall and docs

export async function containerPosts(col: 'group_id' | 'event_id' | 'page_id', id: string, before?: string, pageSize = 20): Promise<PostRow[]> {
  let q = sb().from('posts').select('*').eq(col, id).order('created_at', { ascending: false }).limit(pageSize);
  if (before) q = q.lt('created_at', before);
  const rows = must(await q) as PostRow[];
  await preparePosts(rows);
  return rows;
}

export function groupAudience(g: GroupRow) {
  return g.privacy === 'open' ? { kind: 'public' as const } : { kind: 'audience' as const, id: g.audience_id };
}

export { KeyWaitingError };
