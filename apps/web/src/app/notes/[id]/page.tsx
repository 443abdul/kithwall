'use client';
// A note (reference vNote): title, author, date, body, tagged friends, Like · Comment · Share.
import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { AvatarLink } from '@/components/Avatar';
import { ReportDialog } from '@/components/ReportDialog';
import { Ufi, useLikes, type UfiHandle } from '@/components/feed/Ufi';
import { ShareDialog, canShare } from '@/components/feed/ShareDialog';
import { ConfirmDialog } from '@/components/social/Dialog';
import { AudienceMark, Linkify, NameList, Unverified, Waiting } from '@/components/social/bits';
import { NoteEditor } from '@/components/social/NoteEditor';
import { postContentKey, readPost } from '@/lib/content';
import { deletePost, fetchPost } from '@/lib/feed/feed';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { clock, longDate } from '@/lib/format';
import { useRef } from 'react';
import '@/styles/social.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function NoteView({ id }: { id: string }) {
  useKeyringVersion();
  usePeopleVersion();
  const { userId, status } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const ufi = useRef<UfiHandle>(null);
  const q = useQuery({ queryKey: ['post', id], enabled: status === 'ready' && UUID.test(id), queryFn: () => fetchPost(id) });
  const likes = useLikes('post', id);
  const [dialog, setDialog] = useState<'delete' | 'report' | 'share' | 'edit' | null>(null);
  const row = q.data;
  if (!UUID.test(id) || (!q.isLoading && (!row || row.kind !== 'note'))) {
    return <div className="note">This note has been deleted, or you don&rsquo;t have permission to see it. <Link href="/notes">Back to Notes</Link></div>;
  }
  if (!row) return <div className="gray">Loading…</div>;
  const res = readPost(row);
  const author = people.person(row.author_id);
  if (!res.ok) return <>{res.reason === 'waiting' ? <Waiting authorId={row.author_id} what="this note" /> : <Unverified />}</>;
  const p = res.value;
  const note = p.note!;
  const mine = row.author_id === userId;
  const liked = (likes.data ?? []).some((l) => l.user_id === userId);
  let ck: Uint8Array | null = null;
  try { ck = postContentKey(row); } catch { ck = null; }
  if (dialog === 'edit') return <><Title icon="note">Edit Note</Title><NoteEditor existing={{ row, payload: p }} /></>;
  return (
    <>
      <Title icon="note" right={<>{mine && <><a role="button" tabIndex={0} onClick={() => setDialog('edit')} onKeyDown={(e) => { if (e.key === 'Enter') setDialog('edit'); }}>Edit</a> &middot;{' '}
        <a role="button" tabIndex={0} onClick={() => setDialog('delete')} onKeyDown={(e) => { if (e.key === 'Enter') setDialog('delete'); }}>Delete</a> &middot; </>}
        {!mine && <><a role="button" tabIndex={0} onClick={() => setDialog('report')} onKeyDown={(e) => { if (e.key === 'Enter') setDialog('report'); }}>Report</a> &middot; </>}
        <Link href="/notes">Back to Notes</Link></>}>{note.title || 'Untitled note'}</Title>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <AvatarLink id={row.author_id} size={50} />
        <div><b>{author ? <Link href={`/${author.username}`}>{author.name}</Link> : '…'}</b><br />
          <span className="gray">{longDate(row.created_at)} at {clock(new Date(row.created_at))}{row.edited_at ? ' · edited' : ''}</span><br />
          <AudienceMark isPublic={row.is_public} /></div>
      </div>
      <div className="kw-notebody"><Linkify text={note.body} /></div>
      {note.tagged?.length ? <p className="gray" style={{ marginBottom: 10 }}>In this note: <NameList ids={note.tagged} max={20} /></p> : null}
      <div className="sf">
        <a role="button" tabIndex={0} onClick={() => ufi.current?.toggleLike()} onKeyDown={(e) => { if (e.key === 'Enter') ufi.current?.toggleLike(); }}>{liked ? 'Unlike' : 'Like'}</a> &middot;{' '}
        <a role="button" tabIndex={0} onClick={() => ufi.current?.focusComment()} onKeyDown={(e) => { if (e.key === 'Enter') ufi.current?.focusComment(); }}>Comment</a>
        {canShare(row, p) && <> &middot; <a role="button" tabIndex={0} onClick={() => setDialog('share')} onKeyDown={(e) => { if (e.key === 'Enter') setDialog('share'); }}>Share</a></>}
      </div>
      <Ufi ref={ufi} row={row} contentKey={ck} canModerate={mine} expanded />
      {dialog === 'delete' && <ConfirmDialog title="Delete Note" confirmLabel="Delete" onClose={() => setDialog(null)}
        onConfirm={async () => { await deletePost(row, p); await qc.invalidateQueries({ queryKey: ['kind'] }); router.push('/notes'); }}>
        Are you sure you want to delete this note?</ConfirmDialog>}
      {dialog === 'report' && <ReportDialog kind="post" id={row.id} onClose={() => setDialog(null)} disclosure={{ plaintext: p, contentKey: ck, keyKind: 'content' }} />}
      {dialog === 'share' && <ShareDialog row={row} payload={p} onClose={() => setDialog(null)} />}
    </>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AppPage active="notes" right={<TipsBox />}><NoteView id={id} /></AppPage>;
}
