'use client';
// /photos — my albums, friends' recently updated albums, and tags waiting for my review.
import '@/styles/photos.css';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { NameLink } from '@/components/Avatar';
import { useSession } from '@/lib/keys/session';
import { approveTag, getPhoto, listAlbums, myPendingTags, readPhoto, removeTag } from '@/lib/photos';
import { AlbumGrid } from './Albums';
import { LazyImg, errText, useKeysReady } from './common';

export function PhotosHome() {
  const { userId, profile } = useSession();
  const ready = useKeysReady();
  useEffect(() => { document.title = 'Photos | Kithwall'; }, []);
  const mine = useQuery({ queryKey: ['photos', 'albums', 'owner', userId], enabled: ready && !!userId, queryFn: () => listAlbums({ ownerId: userId! }) });
  const friends = useQuery({ queryKey: ['photos', 'albums', 'recent'], enabled: ready && !!userId, queryFn: () => listAlbums({ excludeOwner: userId!, limit: 24 }) });
  return (
    <AppPage active="photos">
      <Title icon="photo" right={<>{profile ? <Link href={`/${profile.username}/photos`}>My Uploads</Link> : null} &nbsp; <Link className="btn" href="/photos/new">+ Create a Photo Album</Link></>}>Photos</Title>
      <TagReview />
      <div className="sub"><span>Recently Updated Albums</span></div>
      {friends.isLoading || !ready ? <div className="gray">Loading…</div> : friends.error ? <div className="err">{errText(friends.error)}</div>
        : <AlbumGrid albums={friends.data ?? []} showOwner empty="None of your friends have shared albums with you yet." />}
      <div className="sub"><span>My Albums</span><Link href="/photos/new">+ Create a Photo Album</Link></div>
      {mine.isLoading || !ready ? <div className="gray">Loading…</div> : mine.error ? <div className="err">{errText(mine.error)}</div>
        : <AlbumGrid albums={mine.data ?? []} empty="You haven't created any albums yet." />}
    </AppPage>
  );
}

/** Pending tags of me in friends' photos: approve or remove. */
export function TagReview() {
  const ready = useKeysReady();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['photos', 'pendingTags'], enabled: ready,
    queryFn: async () => {
      const notices = await myPendingTags(20);
      const rows = await Promise.all(notices.map((n) => getPhoto(n.photo_id)));
      return notices.map((n, i) => ({ n, row: rows[i] })).filter((x) => x.row) as { n: (typeof notices)[number]; row: NonNullable<(typeof rows)[number]> }[];
    },
  });
  const [err, setErr] = useState<string | null>(null);
  const items = q.data ?? [];
  if (!items.length) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr(errText(e)); }
    await qc.invalidateQueries({ queryKey: ['photos'] });
  };
  return (
    <div className="kp-review" role="region" aria-label="Photo tags to review">
      <b>You were tagged in {items.length === 1 ? 'a photo' : `${items.length} photos`}.</b> Approve the tags you&rsquo;re happy with, or remove them.
      {items.map(({ n, row }) => {
        const d = readPhoto(row);
        return (
          <div className="row" key={n.photo_id}>
            <Link href={`/photos/${row.id}`} aria-label="View photo"><LazyImg file={d.ok ? d.value.files.thumb : null} alt={d.ok ? d.value.caption ?? '' : ''} /></Link>
            <div style={{ flex: 1, minWidth: 0 }}><NameLink id={n.tagger_id} /> tagged you{d.ok && d.value.caption ? <> &mdash; &ldquo;{d.value.caption}&rdquo;</> : null}</div>
            <button className="btn b" onClick={() => act(() => approveTag(row.id))}>Approve</button>
            <button className="btn" onClick={() => act(() => (d.ok ? removeTag(row, d.value, n.tagged_id) : Promise.resolve()))}>Remove Tag</button>
          </div>
        );
      })}
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
    </div>
  );
}
