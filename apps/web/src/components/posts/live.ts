'use client';
// Live edits for posts and comments (phase 3). Realtime delivers UPDATEs that pass RLS, so only people who
// can read the post hear about it, and the change carries only ciphertext. Posts already on screen are
// patched in place (re-decrypted by PostCard: readPost caches by id + edited_at); comment threads that are
// loaded refetch. New posts (including scheduled ones going live) are not pushed into the feed: the feed
// stays calm and shows them on the next visit or refresh.
import { useEffect } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { sb } from '@/lib/supabase';
import { useSession } from '@/lib/keys/session';
import { preparePosts } from '@/lib/content';
import { commentsKey } from '@/lib/feed/feed';
import type { CommentRow, PostRow } from '@/lib/types';
import type { FeedPage } from './data';

export function usePostsLive() {
  const qc = useQueryClient();
  const { status, userId } = useSession();
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const ch = sb().channel(`posts-live:${userId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (p) => {
        const row = { ...(p.new as PostRow) };
        if (!row?.id) return;
        // Unchanged large (TOASTed) columns are left out of Realtime records: keep what we have.
        if (row.envelope == null) delete (row as Partial<PostRow>).envelope;
        void preparePosts([row]).then(() => {
          // Feed pages (InfiniteData<FeedPage>) and the permalink (['v2feed', 'post', id] → PostRow | null).
          qc.setQueriesData<InfiniteData<FeedPage> | PostRow | null>({ queryKey: ['v2feed'] }, (data) => {
            if (!data) return data;
            if (!('pages' in data)) return data.id === row.id ? { ...data, ...row } : data;
            let hit = false;
            const pages = data.pages.map((pg) => ({ ...pg, rows: pg.rows.map((r) => (r.id === row.id ? ((hit = true), { ...r, ...row }) : r)) }));
            return hit ? { ...data, pages } : data;
          });
        });
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comments' }, (p) => {
        const c = p.new as CommentRow;
        if (!c?.post_id) return;
        if (qc.getQueryData(commentsKey(c.post_id))) void qc.invalidateQueries({ queryKey: commentsKey(c.post_id) });
      })
      .subscribe();
    return () => { void sb().removeChannel(ch); };
  }, [status, userId, qc]);
}
