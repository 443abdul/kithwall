'use client';
// Privacy switches the server has to enforce (migration 20261022000500, table privacy_prefs):
//  - read receipts: off by default and reciprocal; the encrypted settings hold the same switch;
//  - who may send me connection requests ('everyone' | 'mutual' | 'nobody');
//  - follow and public posts (migration 20261112000100, docs/v2/10-follow-public.md): whether search engines
//    may show my public posts, whether my connections see who I follow, who can comment on my posts and who
//    can mention me.
// Everything else about privacy stays in the encrypted vault (lib/settings.ts).
import { useQuery } from '@tanstack/react-query';
import { sb } from '../supabase';
import { me, useSession } from '../keys/session';
import type { CommentPolicy } from '../types';

export type RequestsFrom = 'everyone' | 'mutual' | 'nobody';
export interface ServerPrivacy {
  readReceipts: boolean; requestsFrom: RequestsFrom;
  /** "Let search engines show my public posts" (off by default). */
  indexPublic: boolean;
  /** "Show who I follow to my connections" (on by default): feeds their suggested accounts. */
  showFollowing: boolean;
  commentPolicy: CommentPolicy; mentionPolicy: CommentPolicy;
}
export const DEFAULT_SERVER_PRIVACY: ServerPrivacy = {
  readReceipts: false, requestsFrom: 'everyone', indexPublic: false, showFollowing: true, commentPolicy: 'everyone', mentionPolicy: 'everyone',
};

const POLICIES: readonly CommentPolicy[] = ['everyone', 'followers', 'connections', 'nobody'];
const policy = (v: unknown): CommentPolicy => (POLICIES.includes(v as CommentPolicy) ? (v as CommentPolicy) : 'everyone');

export async function loadServerPrivacy(): Promise<ServerPrivacy> {
  const { data, error } = await sb().from('privacy_prefs')
    .select('read_receipts, requests_from, index_public, show_following, comment_policy, mention_policy').eq('user_id', me()).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_SERVER_PRIVACY;
  const rf = data.requests_from as string;
  return {
    readReceipts: !!data.read_receipts, requestsFrom: rf === 'mutual' || rf === 'nobody' ? rf : 'everyone',
    indexPublic: !!data.index_public, showFollowing: data.show_following !== false,
    commentPolicy: policy(data.comment_policy), mentionPolicy: policy(data.mention_policy),
  };
}

export async function saveServerPrivacy(patch: Partial<ServerPrivacy>): Promise<ServerPrivacy> {
  const cur = await loadServerPrivacy();
  const next = { ...cur, ...patch };
  const { error } = await sb().from('privacy_prefs').upsert({
    user_id: me(), read_receipts: next.readReceipts, requests_from: next.requestsFrom,
    index_public: next.indexPublic, show_following: next.showFollowing, comment_policy: next.commentPolicy, mention_policy: next.mentionPolicy,
  });
  if (error) throw new Error(error.message);
  return next;
}

export function useServerPrivacy() {
  const { status, userId } = useSession();
  return useQuery({ queryKey: ['privacy', userId], enabled: status === 'ready', queryFn: loadServerPrivacy, staleTime: 60_000 });
}

/** Others' read markers for a conversation (empty unless both sides turned read receipts on). */
export async function fetchReceipts(convId: string): Promise<{ user_id: string; last_read_at: string }[]> {
  const { data, error } = await sb().rpc('conversation_receipts', { conv: convId });
  if (error) throw new Error(error.message);
  return (data ?? []) as { user_id: string; last_read_at: string }[];
}

export function useReceipts(convId: string | null | undefined, enabled: boolean, newestId: string | undefined) {
  const { status } = useSession();
  return useQuery({
    queryKey: ['receipts', convId, newestId],
    enabled: status === 'ready' && !!convId && enabled,
    queryFn: () => fetchReceipts(convId!),
    refetchInterval: enabled ? 20_000 : false,
    staleTime: 10_000,
  });
}
