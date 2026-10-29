'use client';
// A post's heart, shared by PostCard and the gallery's post panel: optimistic toggle on the per-post likes
// cache (seeded in batches by the feed, kept current by Realtime), with the author notified on a new like.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useToast } from '@/components/ui/Toast';
import { setLike } from '@/lib/content';
import { fetchPostLikes, likesKey, notifySafe } from '@/lib/feed/feed';
import { useSession } from '@/lib/keys/session';
import type { LikeRow, PostRow } from '@/lib/types';
import { ENGAGEMENT_STALE } from './Comments';

export function usePostLike(row: PostRow) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId } = useSession();
  const likes = useQuery({ queryKey: likesKey('post', row.id), queryFn: () => fetchPostLikes('post', row.id), staleTime: ENGAGEMENT_STALE });
  const liked = !!likes.data?.some((l) => l.user_id === userId);
  const count = likes.data?.length ?? 0;

  async function toggle() {
    if (!userId) return;
    const key = likesKey('post', row.id);
    const prev = qc.getQueryData<LikeRow[]>(key) ?? [];
    const next = liked ? prev.filter((l) => l.user_id !== userId)
      : [...prev, { target_kind: 'post' as const, target_id: row.id, user_id: userId, created_at: new Date().toISOString() }];
    qc.setQueryData(key, next);
    try {
      await setLike('post', row.id, !liked);
      if (!liked) await notifySafe(row.author_id, 'like', 'post', row.id);
    } catch {
      qc.setQueryData(key, prev);
      toast({ message: t('feed.failed'), tone: 'danger' });
    }
  }

  return { liked, count, toggle, rows: likes.data ?? [] };
}
