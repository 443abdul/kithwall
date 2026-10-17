'use client';
// /pages — reference vPages. Pages are public; they only exist while the operator has turned on
// the Public audience. Which pages you like is private to you.
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { ErrorBox, PublicWarning, useAction } from '@/components/groups/bits';
import { useAppSetting } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { likeCount, myLikedPageIds, myLikedPages, myPages, searchPages, setPageLike, type PageRow } from '@/lib/pages';

export function PageTile({ page, size = 50 }: { page: Pick<PageRow, 'id' | 'name'>; size?: number }) {
  let h = 0;
  for (let i = 0; i < page.id.length; i++) h = (h * 31 + page.id.charCodeAt(i)) >>> 0;
  const colors = ['#e2a400', '#3b5998', '#5aa33a', '#c0392b', '#8e44ad', '#16a085', '#d35400', '#2c3e50'];
  const letter = (page.name.trim()[0] ?? '?').toUpperCase();
  return (
    <svg className="av" width={size} height={size} viewBox="0 0 50 50" aria-hidden>
      <rect width="50" height="50" fill={colors[h % colors.length]} />
      <text x="25" y="33" textAnchor="middle" fontSize="24" fontWeight="bold" fill="#fff" fontFamily="tahoma">{letter}</text>
    </svg>
  );
}

export function ComingSoon() {
  return (
    <>
      <Title icon="page">Pages</Title>
      <div className="note" style={{ lineHeight: '16px' }}>
        <b style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Pages are coming soon.</b>
        Pages are for bands, businesses, causes and public figures — things meant to be seen by everyone. Because everything on a
        Page is <b>public and not encrypted</b>, Pages only open once Kithwall turns on public sharing.
        <br /><br />
        Until then, everything on Kithwall stays end-to-end encrypted between you and the people you choose. When Pages arrive,
        the Pages you like will stay private: only you will see them.
      </div>
      <div className="gray">In the meantime, try <Link href="/groups">Groups</Link> for things you share with a few people.</div>
    </>
  );
}

function PageRowItem({ page, liked, onToggle, busy }: { page: PageRow; liked: boolean; onToggle: () => void; busy: boolean }) {
  const n = useQuery({ queryKey: ['pageLikes', page.id], queryFn: () => likeCount(page.id) });
  return (
    <div className="it">
      <Link className="avl" href={`/pages/${page.id}`} aria-label={page.name}><PageTile page={page} /></Link>
      <div className="d">
        <Link className="big" href={`/pages/${page.id}`}>{page.name}</Link><br />
        <span className="gray">{page.category}{n.data !== undefined ? <> &middot; {n.data.toLocaleString('en-US')} {n.data === 1 ? 'person likes' : 'people like'} this</> : null}</span>
      </div>
      <div className="x">
        {liked ? <span className="gray"><Icon name="like" /> You like this</span>
          : <button type="button" className="btn" disabled={busy} onClick={onToggle}><Icon name="like" /> Like</button>}
      </div>
    </div>
  );
}

export function PagesHome() {
  const pub = useAppSetting('public_audience_enabled');
  const { status } = useSession();
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const qc = useQueryClient();
  const act = useAction();
  const enabled = status === 'ready' && pub.data === true;
  const liked = useQuery({ queryKey: ['pages', 'liked'], enabled, queryFn: myLikedPages });
  const likedIds = useQuery({ queryKey: ['pages', 'likedIds'], enabled, queryFn: myLikedPageIds });
  const mine = useQuery({ queryKey: ['pages', 'mine'], enabled, queryFn: myPages });
  const browse = useQuery({ queryKey: ['pages', 'search', query], enabled, queryFn: () => searchPages(query) });
  const likedSet = new Set(likedIds.data ?? []);

  if (pub.isLoading) return <AppPage active="pages" right={null}><div className="gray">Loading&hellip;</div></AppPage>;
  if (!pub.data) return <AppPage active="pages" right={null}><ComingSoon /></AppPage>;

  const like = (p: PageRow) => act.run(async () => {
    await setPageLike(p.id, true);
    await qc.invalidateQueries({ queryKey: ['pages'] });
    await qc.invalidateQueries({ queryKey: ['pageLikes', p.id] });
  });

  return (
    <AppPage active="pages" right={<RightBox title="Your Likes Are Private"><div style={{ lineHeight: '15px' }}>
      <Icon name="lock" /> Only you can see which Pages you like. Page owners and other people see just the total number of likes.</div></RightBox>}>
      <Title icon="page" right={<Link className="btn" href="/pages/new">Create a Page</Link>}>Pages</Title>
      <PublicWarning what="Pages and everything posted on them" />
      <ErrorBox error={act.error} />
      <form className="cm-search" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(term.trim()); }}>
        <input type="text" aria-label="Search Pages" placeholder="Search Pages" value={term} onChange={(e) => setTerm(e.target.value)} />
        <button type="submit" className="btn">Search</button>
      </form>

      {!query && <>
        <div className="sub"><span>Pages You Like <span className="gray">({liked.data?.length ?? 0})</span> <Icon name="lock" title="Private — only you can see this" /></span></div>
        <div className="list">
          {(liked.data ?? []).map((p) => <PageRowItem key={p.id} page={p} liked busy={act.busy} onToggle={() => undefined} />)}
          {liked.data && !liked.data.length && <div className="gray" style={{ padding: '6px 0' }}>You haven&rsquo;t liked any Pages yet.</div>}
        </div>
        {(mine.data?.length ?? 0) > 0 && <>
          <div className="sub"><span>Pages You Manage</span></div>
          <div className="list">{mine.data!.map((p) => <PageRowItem key={p.id} page={p} liked={likedSet.has(p.id)} busy={act.busy} onToggle={() => void like(p)} />)}</div>
        </>}
      </>}

      <div className="sub"><span>{query ? <>Results for &ldquo;{query}&rdquo;</> : 'Browse Pages'}</span>{query && <a role="button" tabIndex={0} onClick={() => { setQuery(''); setTerm(''); }}>Clear</a>}</div>
      <div className="list">
        {(browse.data ?? []).map((p) => <PageRowItem key={p.id} page={p} liked={likedSet.has(p.id)} busy={act.busy} onToggle={() => void like(p)} />)}
        {browse.data && !browse.data.length && <div className="gray" style={{ padding: '6px 0' }}>No Pages found.</div>}
      </div>
    </AppPage>
  );
}
