'use client';
// Row of 5 recent tagged photos at the top of a profile (Dec 2010 design). Owned by the photos work.
import '@/styles/photos.css';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { readPhoto, taggedPhotos, type PhotoRow } from '@/lib/photos';
import { LazyImg, useKeysReady, usePhotoPayload } from './common';

export function PhotoStrip({ userId }: { userId: string }) {
  const ready = useKeysReady();
  const q = useQuery({
    queryKey: ['photos', 'tagged', userId, 'strip'], enabled: ready && !!userId,
    queryFn: () => taggedPhotos(userId, 12),
  });
  // Only photos we can actually decrypt make it into the strip (re-evaluated when keys arrive).
  const rows = (q.data ?? []).filter((r) => readPhoto(r).ok).slice(0, 5);
  if (!rows.length) return null;
  return (
    <div className="pstrip" aria-label="Recent photos">
      {rows.map((r) => <StripItem key={r.id} row={r} />)}
    </div>
  );
}

function StripItem({ row }: { row: PhotoRow }) {
  const d = usePhotoPayload(row);
  if (!d || !d.ok) return null;
  const cap = d.value.caption ?? '';
  return (
    <Link href={`/photos/${row.id}`} title={cap} aria-label={cap || 'Photo'}>
      <LazyImg file={d.value.files.thumb} alt={cap} />
    </Link>
  );
}
