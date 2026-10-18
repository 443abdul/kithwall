'use client';
// A News Feed / Wall story (reference storyHTML + ufi). Reusable for group, event and page walls:
//
//   <Story row={postRow} wallContext={ownerOrContainerId} canModerate={isGroupAdmin} />
//
// The post is verified and decrypted on this device (lib/content readPost). Items whose key
// hasn't arrived yet show the waiting state; items that fail verification are hidden behind
// "This item couldn't be verified." (dev-guide rule 5).
import Link from 'next/link';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { AvatarLink } from '@/components/Avatar';
import { ReportDialog } from '@/components/ReportDialog';
import { PhotoGrid } from '@/components/photos/PhotoGrid';
import { AudienceIcon, Linkify, Unverified, Waiting } from '@/components/social/bits';
import { ConfirmDialog } from '@/components/social/Dialog';
import { CheckinAtt, LIFE_VERBS, LifeEventAtt, LinkCard, NoteAtt, SharedAtt, WithFriends, placeHref } from './Attachments';
import { Poll } from './Poll';
import { VideoAtt } from './MediaAtt';
import { Ufi, useLikes, type UfiHandle } from './Ufi';
import { ShareDialog, canShare } from './ShareDialog';
import { useMyLists } from './AudienceSelect';
import { postContentKey, readPost } from '@/lib/content';
import { deletePost, indexPost } from '@/lib/feed/feed';
import { getPrefs, hidePost, unhidePost, usePrefsVersion } from '@/lib/social/local';
import { keyring } from '@/lib/keys/keyring';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { when } from '@/lib/format';
import type { PostPayload, PostRow } from '@/lib/types';

const KIND_ICON: Partial<Record<PostRow['kind'], string>> = {
  checkin: 'place', question: 'question', photo: 'photo', link: 'link', video: 'video', life_event: 'heart',
  note: 'note', share: 'share', game: 'game',
};

export interface StoryProps {
  row: PostRow;
  /** Id of the wall/container being viewed; suppresses "Alice ▸ Bob" when Bob's wall is shown. */
  wallContext?: string;
  /** Extra permission to delete (e.g. group admins). Author and wall owner can always delete. */
  canModerate?: boolean;
  /** Permalink view: all comments shown and the comment box open. */
  expanded?: boolean;
  onRemoved?: (id: string) => void;
}

function Actor({ id }: { id: string }) {
  const p = people.person(id);
  return p ? <Link className="actor" href={`/${p.username}`}>{p.name}</Link> : <span className="actor gray">…</span>;
}

export function Story({ row, wallContext, canModerate = false, expanded = false, onRemoved }: StoryProps) {
  useKeyringVersion();
  usePeopleVersion();
  usePrefsVersion();
  const { userId } = useSession();
  const qc = useQueryClient();
  const lists = useMyLists();
  const ufi = useRef<UfiHandle>(null);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'report' | 'share' | null>(null);
  const [gone, setGone] = useState(false);
  const likes = useLikes('post', row.id);
  const liked = !!userId && (likes.data ?? []).some((l) => l.user_id === userId);

  const res = readPost(row);
  const payload = res.ok ? res.value : null;
  if (payload) indexPost(row, payload);
  const contentKey = useMemo(() => {
    if (!res.ok || row.is_public) return null;
    try { return postContentKey(row); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.envelope, res.ok]);

  const isAuthor = row.author_id === userId;
  const canDelete = isAuthor || row.wall_owner_id === userId || canModerate;
  const hidden = getPrefs().hiddenPosts.includes(row.id);

  if (gone) return null;
  if (hidden && !expanded) {
    return (
      <div className="story kw-hidden">
        <span className="gray">This story is hidden from your News Feed.</span>{' '}
        <a role="button" tabIndex={0} onClick={() => unhidePost(row.id)} onKeyDown={(e) => { if (e.key === 'Enter') unhidePost(row.id); }}>Undo</a>
      </div>
    );
  }

  const showTo = !!row.wall_owner_id && row.wall_owner_id !== row.author_id && wallContext !== row.wall_owner_id;
  const arrow = showTo ? <> <span className="arr">&#9654;</span> <Actor id={row.wall_owner_id!} /></> : null;

  let head: ReactNode;
  let att: ReactNode = null;
  if (!payload) {
    head = <><Actor id={row.author_id} />{arrow}</>;
    att = res.ok ? null : res.reason === 'waiting' ? <Waiting authorId={row.author_id} what="this post" /> : <Unverified />;
  } else {
    ({ head, att } = renderBody(row, payload, arrow, contentKey));
  }

  let audLabel: string | undefined;
  if (isAuthor) {
    if (row.group_id) audLabel = 'Group members';
    else if (row.event_id) audLabel = 'Event guests';
    else if (row.audience_id === keyring.friendsAudience?.id) audLabel = 'Friends';
    else if (row.audience_id === keyring.selfAudience?.id) audLabel = 'Only Me';
    else audLabel = lists.data?.find((l) => l.id === row.audience_id)?.name ?? (row.is_public ? undefined : 'Custom');
  }

  const remove = async () => {
    await deletePost(row, payload);
    setGone(true);
    onRemoved?.(row.id);
    void qc.invalidateQueries({ queryKey: ['feed'] });
    void qc.invalidateQueries({ queryKey: ['wall'] });
    void qc.invalidateQueries({ queryKey: ['kind'] });
  };

  const sic = KIND_ICON[row.kind];
  return (
    <div className="story" id={`st-${row.id}`}>
      <AvatarLink id={row.author_id} size={50} />
      <div className="sb">
        {/* Mobile-only header and action bar (styles/mobile.css); desktop keeps the 2010 inline layout. */}
        <div className="m-head">
          <span className="m-names"><Actor id={row.author_id} />{showTo ? <> <span className="arr">&#9654;</span> <Actor id={row.wall_owner_id!} /></> : null}</span>
          <span className="m-meta"><Link href={`/post/${row.id}`}>{when(row.created_at)}</Link>{' · '}<AudienceIcon isPublic={row.is_public} label={audLabel} /></span>
        </div>
        <div className="sh">{head}</div>
        {att}
        <div className="sf">
          {sic ? <Icon name={sic} /> : null}
          {payload && <>
            <a role="button" tabIndex={0} onClick={() => ufi.current?.toggleLike()} onKeyDown={(e) => { if (e.key === 'Enter') ufi.current?.toggleLike(); }}>
              {liked ? 'Unlike' : 'Like'}</a>
            {' · '}
            <a role="button" tabIndex={0} onClick={() => ufi.current?.focusComment()} onKeyDown={(e) => { if (e.key === 'Enter') ufi.current?.focusComment(); }}>Comment</a>
            {canShare(row, payload) && <>{' · '}<a role="button" tabIndex={0} onClick={() => setDialog('share')}
              onKeyDown={(e) => { if (e.key === 'Enter') setDialog('share'); }}>Share</a></>}
            {' · '}
          </>}
          <Link href={`/post/${row.id}`} className="gray">{when(row.created_at)}</Link>
          {' '}<AudienceIcon isPublic={row.is_public} label={audLabel} />
          {row.kind === 'checkin' && payload?.checkin ? <> via <Link href="/places">Places</Link></> : null}
          {row.kind === 'question' ? <> via <Link href="/questions">Questions</Link></> : null}
          {row.kind === 'game' ? <> via <Link href="/games/kithville">Kithville</Link></> : null}
        </div>
        {payload && (
          <div className="m-actions" role="group" aria-label="Post actions">
            <button type="button" className={liked ? 'on' : ''} aria-pressed={liked} onClick={() => ufi.current?.toggleLike()}><Icon name="like" /> {liked ? 'Liked' : 'Like'}</button>
            <button type="button" onClick={() => ufi.current?.focusComment()}><Icon name="comment" /> Comment</button>
            {canShare(row, payload) && <button type="button" onClick={() => setDialog('share')}><Icon name="share" /> Share</button>}
          </div>
        )}
        {payload && <Ufi ref={ufi} row={row} contentKey={contentKey} canModerate={canDelete} expanded={expanded} />}
      </div>
      <button type="button" className="sx kw-sx" title="Options" aria-label="Story options" aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}>&times;</button>
      {menu && (
        <div className="kw-menu" role="menu" onMouseLeave={() => setMenu(false)}>
          {!expanded && <button type="button" role="menuitem" onClick={() => { setMenu(false); hidePost(row.id); }}>Hide this story</button>}
          {canDelete && <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog('delete'); }}>Delete post</button>}
          {!isAuthor && payload && <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog('report'); }}>Report this post</button>}
          <button type="button" role="menuitem" onClick={() => setMenu(false)}>Cancel</button>
        </div>
      )}
      {dialog === 'delete' && (
        <ConfirmDialog title="Delete Post" confirmLabel="Delete" onClose={() => setDialog(null)} onConfirm={remove}>
          Are you sure you want to delete this post? Its comments and likes will be deleted too.
        </ConfirmDialog>
      )}
      {dialog === 'report' && payload && (
        <ReportDialog kind="post" id={row.id} onClose={() => setDialog(null)}
          disclosure={{ plaintext: payload, contentKey, keyKind: 'content' }} />
      )}
      {dialog === 'share' && payload && <ShareDialog row={row} payload={payload} onClose={() => setDialog(null)} />}
    </div>
  );
}

function renderBody(row: PostRow, p: PostPayload, arrow: ReactNode, contentKey: Uint8Array | null): { head: ReactNode; att: ReactNode } {
  const a = <Actor id={row.author_id} />;
  const text = p.text ? <Linkify text={p.text} /> : null;
  switch (row.kind) {
    case 'photo': {
      const n = p.photos?.length ?? 0;
      return {
        head: <>{a}{arrow} {text ?? (n > 1 ? `added ${n} new photos.` : 'added a new photo.')}<WithFriends ids={p.tagged} /></>,
        att: n ? <div className="att kw-photos"><PhotoGrid photos={p.photos!} /></div> : null,
      };
    }
    case 'link':
      return { head: <>{a}{arrow} {text ?? 'posted a link.'}</>, att: p.link ? <LinkCard link={p.link} /> : null };
    case 'video':
      return {
        head: <>{a}{arrow} {text ?? 'posted a video.'}</>,
        att: p.video?.file ? <VideoAtt video={p.video} /> : <div className="att gray">This video is no longer available.</div>,
      };
    case 'question':
      return {
        head: <>{a}{arrow} asked: <b>{p.question?.text}</b></>,
        att: p.question ? <Poll row={row} question={p.question} contentKey={contentKey} /> : null,
      };
    case 'checkin':
      return {
        head: <>{a} was at {p.checkin ? <Link href={placeHref(p.checkin.place)}>{p.checkin.place}</Link> : 'somewhere'}<WithFriends ids={p.checkin?.with} />.
          {text ? <div style={{ marginTop: 2 }}>{text}</div> : null}</>,
        att: p.checkin ? <CheckinAtt checkin={p.checkin} /> : null,
      };
    case 'note':
      return {
        head: <>{a} wrote a new note: <Link href={`/notes/${row.id}`}>{p.note?.title || 'Untitled note'}</Link><WithFriends ids={p.note?.tagged} />.</>,
        att: p.note ? <NoteAtt postId={row.id} note={p.note} /> : null,
      };
    case 'life_event': {
      const ev = p.lifeEvent;
      const verb = ev ? LIFE_VERBS[ev.kind] : undefined;
      return {
        head: <>{a} {verb && ev?.with ? <>{verb} <Actor id={ev.with} />.</> : (ev?.title ?? 'updated their life events.')}</>,
        att: ev ? <LifeEventAtt ev={ev} /> : null,
      };
    }
    case 'share':
      return { head: <>{a}{arrow} {p.sharedText ? <Linkify text={p.sharedText} /> : 'shared a post.'}</>, att: <SharedAtt postId={row.shared_post_id} /> };
    case 'game':
      return { head: <>{a} {p.game?.text ?? 'played Kithville.'}</>, att: null };
    default:
      return { head: <>{a}{arrow} {text}<WithFriends ids={p.tagged} /></>, att: null };
  }
}
