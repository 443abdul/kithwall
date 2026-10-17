'use client';
// Album cards/grids and the photo thumbnail grid used by /photos, /[username]/photos and albums.
import '@/styles/photos.css';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { NameLink } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { when, plural } from '@/lib/format';
import { albumSummary, type AlbumRow, type PhotoRow } from '@/lib/photos';
import { LazyImg, useAlbumPayload, useInView, useKeysReady, usePhotoPayload } from './common';

export function AlbumGrid({ albums, showOwner = false, empty = 'No albums yet.' }: { albums: AlbumRow[]; showOwner?: boolean; empty?: string }) {
  if (!albums.length) return <div className="gray">{empty}</div>;
  return <div className="ph">{albums.map((a) => <AlbumCard key={a.id} album={a} showOwner={showOwner} />)}</div>;
}

export function AlbumCard({ album, showOwner }: { album: AlbumRow; showOwner?: boolean }) {
  const ready = useKeysReady();
  const d = useAlbumPayload(album);
  const [ref, seen] = useInView<HTMLDivElement>();
  const coverId = d?.ok ? d.value.coverId : undefined;
  const q = useQuery({
    queryKey: ['photos', 'summary', album.id, album.updated_at, coverId ?? ''], enabled: ready && seen,
    queryFn: () => albumSummary(album, coverId),
  });
  const cover = usePhotoPayload(q.data?.cover);
  const name = d?.ok ? d.value.name : d?.reason === 'unverified' ? 'Unverified album' : 'Encrypted album';
  return (
    <div ref={ref} className="kp-card">
      <Link href={`/photos/album/${album.id}`} aria-label={name}>
        <span className="thumb">
          <LazyImg file={cover?.ok ? cover.value.files.thumb : null} alt={cover?.ok ? cover.value.caption ?? '' : ''} className={q.data && !q.data.cover ? 'empty' : ''} />
        </span>
      </Link>
      <Link className="nm" href={`/photos/album/${album.id}`}>{name}</Link>
      {d && !d.ok && d.reason === 'waiting' ? <span className="gray small">Waiting for the owner&rsquo;s device to share this.</span> : null}
      {showOwner ? <div><NameLink id={album.owner_id} bold={false} /></div> : null}
      <span className="gray">{q.data ? `${plural(q.data.count, 'photo')} · ` : ''}Updated {when(album.updated_at)}</span>
      {album.is_public ? <div className="gray small"><Icon name="globe" /> Public — not encrypted</div> : null}
    </div>
  );
}

/** Thumbnail grid of photos; links to the viewer. */
export function PhotoThumbGrid({ rows, counts, empty = 'No photos.' }: { rows: PhotoRow[]; counts?: Map<string, { likes: number; comments: number }>; empty?: string }) {
  if (!rows.length) return <div className="gray">{empty}</div>;
  return <div className="ph">{rows.map((r, i) => <PhotoThumb key={r.id} row={r} index={i} counts={counts?.get(r.id)} />)}</div>;
}

export function PhotoThumb({ row, index, counts }: { row: PhotoRow; index: number; counts?: { likes: number; comments: number } }) {
  const d = usePhotoPayload(row);
  const cap = d?.ok ? d.value.caption ?? '' : '';
  return (
    <Link href={`/photos/${row.id}`} aria-label={cap || `Photo ${index + 1}`}>
      <span className="thumb"><LazyImg file={d?.ok ? d.value.files.thumb : null} alt={cap} /></span>
      {counts && (counts.likes || counts.comments) ? (
        <><br /><span className="kp-cnt">
          {counts.likes ? <span><Icon name="like" />{counts.likes}</span> : null}
          {counts.comments ? <span><Icon name="comment" />{counts.comments}</span> : null}
        </span></>
      ) : null}
    </Link>
  );
}
