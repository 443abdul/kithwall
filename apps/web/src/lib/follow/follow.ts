'use client';
// Follow (docs/v2/10-follow-public.md). An account that turned "Let people follow me" on can be followed by
// anyone signed in, at once and without approval. Its Followers posts stay end-to-end encrypted: the key of
// its followers audience is minted and handed out by the owner's own devices (lib/keys/keyring), so a new
// follower reads nothing until one of them has been online. The server knows who follows whom (it has to,
// to decide who may fetch what) and nothing about what the posts say.
//
// Lists here carry what the server shows about an account (handle, public name) and never go through the
// people directory: followers are strangers, and the directory pins the identity key of everyone it loads.
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '../supabase';
import { me, refreshProfile, useSession } from '../keys/session';
import { keyring } from '../keys/keyring';
import { notify } from '../friends';

export interface AccountCard { id: string; username: string; name: string | null }

export interface FollowInfo {
  /** The account lets people follow it. */
  followEnabled: boolean;
  /** Followers including connections; null when the account doesn't show a count. */
  followers: number | null;
  iFollow: boolean;
  followsMe: boolean;
  /** Its followers audience and current epoch, told only to its followers (to see whether the key is here yet). */
  audienceId: string | null; audienceEpoch: number | null;
}

export async function followInfo(userId: string): Promise<FollowInfo | null> {
  const rows = must(await sb().rpc('follow_info', { p_user: userId })) as {
    follow_enabled: boolean; followers: number | null; i_follow: boolean; follows_me: boolean; audience_id: string | null; audience_epoch: number | null;
  }[] | null;
  const r = rows?.[0];
  if (!r) return null;
  return {
    followEnabled: !!r.follow_enabled, followers: r.followers === null ? null : Number(r.followers), iFollow: !!r.i_follow,
    followsMe: !!r.follows_me, audienceId: r.audience_id, audienceEpoch: r.audience_epoch,
  };
}

export const followKey = (userId: string | null | undefined) => ['follows', 'info', userId] as const;

/** Follow facts about a person; lives under ['follows'] so follow changes refresh it. */
export function useFollowInfo(userId: string | null | undefined) {
  const { status } = useSession();
  return useQuery({ queryKey: followKey(userId), enabled: status === 'ready' && !!userId, staleTime: 30_000, queryFn: () => followInfo(userId!) });
}

/** Has the key of this account's Followers posts reached this device? (false: its owner's device hasn't been online since) */
export function followKeyReady(info: Pick<FollowInfo, 'audienceId' | 'audienceEpoch'> | null | undefined): boolean {
  return !!info?.audienceId && info.audienceEpoch !== null && keyring.has(info.audienceId, info.audienceEpoch);
}

export async function follow(userId: string): Promise<void> {
  const r = await sb().from('follows').insert({ follower_id: me(), followee_id: userId });
  if (r.error && r.error.code !== '23505') must(r);
  if (!r.error) await notify(userId, 'follow', 'profile', me()).catch(() => undefined);
}

export async function unfollow(userId: string): Promise<void> {
  must(await sb().from('follows').delete().match({ follower_id: me(), followee_id: userId }));
}

/** Remove one of my followers; my followers key is rotated so they can't open anything I share from now on. */
export async function removeFollower(userId: string): Promise<void> {
  must(await sb().from('follows').delete().match({ follower_id: userId, followee_id: me() }));
  await keyring.afterFollowerRemoved(userId);
}

/**
 * Turn "Let people follow me" on or off. On needs a public name (followers can't read my encrypted
 * profile); the database creates my followers audience and this device gives it its first key. Off: nobody
 * new can follow, people who only follow me stop receiving my posts, and my public posts leave public view
 * until I turn it back on. `keepName`: I'm also listed in the directory, which shows the same name.
 */
export async function setFollowEnabled(on: boolean, publicName?: string, keepName = false): Promise<void> {
  if (on) {
    const name = (publicName ?? '').trim().slice(0, 80);
    if (!name) throw new Error('A public name is needed.');
    must(await sb().from('profiles').update({ follow_enabled: true, display_name_public: name }).eq('id', me()));
    await keyring.ensureFollowersAudience();
  } else {
    must(await sb().from('profiles').update(keepName ? { follow_enabled: false } : { follow_enabled: false, display_name_public: null }).eq('id', me()));
  }
  await refreshProfile();
}

interface FollowRow { created_at: string; profiles: { id: string; username: string; display_name_public: string | null } | null }
const cards = (rows: FollowRow[]) => rows.filter((r) => r.profiles).map((r) => ({ id: r.profiles!.id, username: r.profiles!.username, name: r.profiles!.display_name_public, at: r.created_at }));

/** People who follow me (connections count as followers too, but are listed under Connections). */
export async function myFollowers(limit = 500): Promise<(AccountCard & { at: string })[]> {
  return cards(must(await sb().from('follows').select('created_at, profiles!follows_follower_id_fkey(id, username, display_name_public)')
    .eq('followee_id', me()).order('created_at', { ascending: false }).limit(limit)) as unknown as FollowRow[]);
}

export async function myFollowing(limit = 500): Promise<(AccountCard & { at: string })[]> {
  return cards(must(await sb().from('follows').select('created_at, profiles!follows_followee_id_fkey(id, username, display_name_public)')
    .eq('follower_id', me()).order('created_at', { ascending: false }).limit(limit)) as unknown as FollowRow[]);
}

export async function myFollowingIds(): Promise<string[]> {
  return (must(await sb().from('follows').select('followee_id').eq('follower_id', me()).limit(5000)) as { followee_id: string }[]).map((r) => r.followee_id);
}

export interface SearchHit extends AccountCard { followers: number; iFollow: boolean }

/** Search by name or @handle. The server only ever returns accounts that let people follow them. */
export async function searchAccounts(q: string): Promise<SearchHit[]> {
  const rows = must(await sb().rpc('search_accounts', { p_q: q })) as { id: string; username: string; display_name: string | null; followers: number; i_follow: boolean }[] | null;
  return (rows ?? []).map((r) => ({ id: r.id, username: r.username, name: r.display_name, followers: Number(r.followers), iFollow: !!r.i_follow }));
}

// ---------------------------------------------------------------------------------------------
// Restrict: comments this person writes on my posts are shown only to them and to me. They are not told.

export async function restrict(userId: string): Promise<void> {
  const r = await sb().from('restrictions').insert({ owner_id: me(), target_id: userId });
  if (r.error && r.error.code !== '23505') must(r);
}

export async function unrestrict(userId: string): Promise<void> {
  must(await sb().from('restrictions').delete().match({ owner_id: me(), target_id: userId }));
}

export async function myRestricted(): Promise<AccountCard[]> {
  const rows = must(await sb().from('restrictions').select('target_id, profiles!restrictions_target_id_fkey(id, username, display_name_public)')
    .eq('owner_id', me()).order('created_at', { ascending: false })) as unknown as { target_id: string; profiles: { id: string; username: string; display_name_public: string | null } | null }[];
  return rows.map((r) => ({ id: r.target_id, username: r.profiles?.username ?? '', name: r.profiles?.display_name_public ?? null }));
}

export const restrictedKey = ['follows', 'restricted'] as const;

/** Ids I restricted (for the "only they can see this" note on their comments and the menu on a person). */
export function useRestricted() {
  const { status } = useSession();
  return useQuery({
    queryKey: restrictedKey, enabled: status === 'ready', staleTime: 60_000,
    queryFn: async () => new Set((must(await sb().from('restrictions').select('target_id').eq('owner_id', me())) as { target_id: string }[]).map((r) => r.target_id)),
  });
}
