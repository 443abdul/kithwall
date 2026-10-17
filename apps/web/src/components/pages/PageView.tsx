'use client';
// /pages/[id] — reference vPage: page picture + nav, Like/Unlike (private), wall by the owner, info.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { ConfirmDialog } from '@/components/social/Dialog';
import { ErrorBox, PublicWarning, useAction } from '@/components/groups/bits';
import { Wall } from '@/components/groups/Wall';
import { useAppSetting } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { longDate } from '@/lib/format';
import { deletePage, getPage, likeCount, myLikedPageIds, pagePosts, postToPage, setPageLike, updatePage } from '@/lib/pages';
import { ComingSoon, PageTile } from './PagesHome';
import { PageFields } from './PageForm';

export function PageView({ id }: { id: string }) {
  const { status, userId } = useSession();
  const pub = useAppSetting('public_audience_enabled');
  const router = useRouter();
  const qc = useQueryClient();
  const act = useAction();
  const [tab, setTab] = useState<'wall' | 'info'>('wall');
  const [editing, setEditing] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const enabled = status === 'ready' && pub.data === true;
  const q = useQuery({ queryKey: ['page', id], enabled, queryFn: () => getPage(id) });
  const likes = useQuery({ queryKey: ['pageLikes', id], enabled, queryFn: () => likeCount(id) });
  const likedIds = useQuery({ queryKey: ['pages', 'likedIds'], enabled, queryFn: myLikedPageIds });

  if (pub.isLoading || q.isLoading) return <AppPage active="pages" right={null}><div className="gray">Loading&hellip;</div></AppPage>;
  if (!pub.data) return <AppPage active="pages" right={null}><ComingSoon /></AppPage>;
  const page = q.data;
  if (!page) return <AppPage active="pages" right={null}><div className="note">This Page could not be found.</div></AppPage>;

  const isOwner = page.owner_id === userId;
  const liked = (likedIds.data ?? []).includes(page.id);
  const n = likes.data ?? 0;
  const toggle = () => act.run(async () => {
    await setPageLike(page.id, !liked);
    await qc.invalidateQueries({ queryKey: ['pageLikes', page.id] });
    await qc.invalidateQueries({ queryKey: ['pages'] });
  });

  return (
    <AppPage active="pages" wide right={null}>
      <div className="prof">
        <div className="pleft">
          <div className="ppic"><PageTile page={page} size={180} /></div>
          <ul className="pnav">
            <li><a className={tab === 'wall' ? 'on' : ''} role="button" tabIndex={0} aria-pressed={tab === 'wall'} onClick={() => setTab('wall')}
              onKeyDown={(e) => { if (e.key === 'Enter') setTab('wall'); }}><Icon name="wall" />Wall</a></li>
            <li><a className={tab === 'info' ? 'on' : ''} role="button" tabIndex={0} aria-pressed={tab === 'info'} onClick={() => setTab('info')}
              onKeyDown={(e) => { if (e.key === 'Enter') setTab('info'); }}><Icon name="info" />Info</a></li>
          </ul>
          {page.about && <div className="pabout" style={{ whiteSpace: 'pre-wrap' }}>{page.about}</div>}
          <div className="lbox"><h4><span>{n.toLocaleString('en-US')} {n === 1 ? 'person likes' : 'people like'} this</span></h4>
            <div className="gray"><Icon name="lock" /> Who likes a Page is private.</div></div>
        </div>
        <div className="pmain">
          <div className="ptop">
            <h1>{page.name}</h1>
            <div className="bs">
              {liked
                ? <span className="gray"><Icon name="like" /> You like this &middot; <a role="button" tabIndex={0} onClick={() => void toggle()} onKeyDown={(e) => { if (e.key === 'Enter') void toggle(); }}>Unlike</a></span>
                : <button type="button" className="btn" disabled={act.busy} onClick={() => void toggle()}><Icon name="like" /> Like</button>}
            </div>
          </div>
          <div className="strip">{page.category}<span className="dt"> &middot; </span><span className="cm-enc"><Icon name="globe" /> Public — not encrypted</span></div>
          <ErrorBox error={act.error} />
          {editing ? (
            <PageFields initial={{ name: page.name, category: page.category, about: page.about ?? '' }} submitLabel="Save Changes"
              onCancel={() => setEditing(false)}
              onSubmit={async (p) => { await updatePage(page.id, p); setEditing(false); await qc.invalidateQueries({ queryKey: ['page', id] }); await qc.invalidateQueries({ queryKey: ['pages'] }); }} />
          ) : tab === 'info' ? (
            <div className="isec">
              <h3><span>Basic Information</span>{isOwner && <a role="button" tabIndex={0} onClick={() => setEditing(true)} onKeyDown={(e) => { if (e.key === 'Enter') setEditing(true); }}>Edit Page</a>}</h3>
              <table><tbody>
                <tr><td className="l">Category:</td><td>{page.category}</td></tr>
                <tr><td className="l">About:</td><td style={{ whiteSpace: 'pre-wrap' }}>{page.about || <span className="gray">Nothing yet.</span>}</td></tr>
                <tr><td className="l">Likes:</td><td>{n.toLocaleString('en-US')}</td></tr>
                <tr><td className="l">Created:</td><td>{longDate(page.created_at)}</td></tr>
              </tbody></table>
              {isOwner && <div style={{ marginTop: 12 }}><button type="button" className="btn" onClick={() => setAskDelete(true)}>Delete Page</button></div>}
            </div>
          ) : (
            <>
              {isOwner && <PublicWarning what="Posts on this Page" />}
              {!isOwner && <div className="gray" style={{ marginBottom: 8 }}>Only the Page&rsquo;s owner posts here. <Link href="/pages">Browse more Pages</Link>.</div>}
              <Wall queryKey={['wall', 'page', page.id]} load={(before) => pagePosts(page, before)}
                publish={isOwner ? (text) => postToPage(page, text) : undefined}
                isPublic placeholder="Write something to your fans..." empty="No posts yet."
                actor={() => <Link href={`/pages/${page.id}`}><b>{page.name}</b></Link>}
                avatar={() => <span className="avl"><PageTile page={page} /></span>}
                canDelete={() => isOwner} />
            </>
          )}
        </div>
      </div>
      {askDelete && <ConfirmDialog title="Delete Page" confirmLabel="Delete Page" onClose={() => setAskDelete(false)}
        onConfirm={async () => { await deletePage(page.id); await qc.invalidateQueries({ queryKey: ['pages'] }); router.push('/pages'); }}>
        This permanently deletes <b>{page.name}</b> and all of its posts.
      </ConfirmDialog>}
    </AppPage>
  );
}
