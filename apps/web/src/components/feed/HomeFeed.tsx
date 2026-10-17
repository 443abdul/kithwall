'use client';
// News Feed page (reference vHome): publisher, Top News · Most Recent stream, right column.
// "Top News" is ranked on this device (spec §5 Feed) — there is no server-side algorithm.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AppPage, Title } from '@/components/Shell';
import { Publisher } from './Publisher';
import { Stream, pageOf, type StreamPage } from './Stream';
import { SocialRightColumn } from './RightColumn';
import { fetchFeed } from '@/lib/content';
import { commentsKey, likesKey, rankTopNews } from '@/lib/feed/feed';
import { reconcileAudiences } from '@/lib/social/graph';
import { useSession } from '@/lib/keys/session';
import type { CommentRow, LikeRow, PostRow } from '@/lib/types';
import '@/styles/social.css';

const PAGE = 20;
const WEEK = 7 * 86_400_000;
const MAX_TOP_PAGES = 5;
type Mode = 'top' | 'recent';

export function HomeFeed() {
  return <AppPage active="home" right={<SocialRightColumn />}><Feed /></AppPage>;
}

function Feed() {
  const qc = useQueryClient();
  const { userId } = useSession();
  // Rendered only on the client (inside AppPage once keys are ready), so sessionStorage is safe here.
  const [mode, setModeState] = useState<Mode>(() => {
    try { return sessionStorage.getItem('kw.feedMode') === 'recent' ? 'recent' : 'top'; } catch { return 'top'; }
  });
  useEffect(() => { void reconcileAudiences(); }, []);
  const setMode = (m: Mode) => { setModeState(m); try { sessionStorage.setItem('kw.feedMode', m); } catch { /* ignore */ } };

  const loadRecent = useCallback(async (before?: string): Promise<StreamPage> => pageOf(await fetchFeed(before, PAGE), PAGE), []);

  // Top News: first load pulls the last 7 days (up to 100 posts) so they can be ranked together.
  const loadTop = useCallback(async (before?: string): Promise<StreamPage> => {
    if (before) return loadRecent(before);
    const all: PostRow[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_TOP_PAGES; i++) {
      const rows = await fetchFeed(cursor, PAGE);
      all.push(...rows);
      if (rows.length < PAGE) return { rows: all };
      cursor = rows[rows.length - 1]!.created_at;
      if (Date.now() - new Date(cursor).getTime() > WEEK) break;
    }
    return { rows: all, next: cursor };
  }, [loadRecent]);

  const arrangeTop = useCallback((rows: PostRow[]) => {
    const cut = Date.now() - WEEK;
    const recent = rows.filter((r) => new Date(r.created_at).getTime() >= cut);
    const older = rows.filter((r) => new Date(r.created_at).getTime() < cut);
    const eng = (id: string) => ({
      likes: qc.getQueryData<LikeRow[]>(likesKey('post', id)) ?? [],
      comments: qc.getQueryData<CommentRow[]>(commentsKey(id)) ?? [],
    });
    return [...rankTopNews(recent, eng, userId ?? ''), ...older];
  }, [qc, userId]);

  return (
    <>
      <Title icon="feed" right={<span className="kw-sort">
        {mode === 'top' ? <b>Top News</b> : <a role="button" tabIndex={0} onClick={() => setMode('top')} onKeyDown={(e) => { if (e.key === 'Enter') setMode('top'); }}>Top News</a>}
        {' · '}
        {mode === 'recent' ? <b>Most Recent</b> : <a role="button" tabIndex={0} onClick={() => setMode('recent')} onKeyDown={(e) => { if (e.key === 'Enter') setMode('recent'); }}>Most Recent</a>}
      </span>}>News Feed</Title>
      <Publisher />
      <Stream key={mode} queryKey={['feed', mode]} load={mode === 'top' ? loadTop : loadRecent}
        arrange={mode === 'top' ? arrangeTop : undefined}
        empty={<>Your News Feed is empty. <Link href="/search">Find friends</Link> to see what they&rsquo;re up to.</>} />
    </>
  );
}
