'use client';
// Photo thumbnails inside a feed story (1–4 photos, 2010 layout), linking to /photos/[id].
// Owned by the photos work; used by the feed. Images decrypt lazily (medium size for a single
// photo, thumbnails otherwise; never the original).
import '@/styles/photos.css';
import Link from 'next/link';
import type { PostPayload } from '@/lib/types';
import { LazyImg } from './common';

const SHOW = 4;

export function PhotoGrid({ photos }: { photos: NonNullable<PostPayload['photos']> }) {
  if (!photos.length) return null;
  if (photos.length === 1) {
    const p = photos[0]!;
    const w = p.files.med.w ?? 4, h = p.files.med.h ?? 3;
    const width = Math.min(390, w);
    return (
      <div className="kp-grid n1">
        <Link href={`/photos/${p.id}`} aria-label={p.caption || 'Photo'}>
          <LazyImg file={p.files.med} alt={p.caption ?? ''} style={{ width, aspectRatio: `${w} / ${h}`, maxHeight: 520 }} />
        </Link>
      </div>
    );
  }
  const shown = photos.slice(0, SHOW);
  const extra = photos.length - shown.length;
  return (
    <div className={`kp-grid n${shown.length}`}>
      {shown.map((p, i) => (
        <Link key={p.id} href={`/photos/${p.id}`} aria-label={extra > 0 && i === shown.length - 1 ? `${extra} more photos` : p.caption || `Photo ${i + 1}`}>
          <LazyImg file={shown.length === 3 && i === 0 ? p.files.med : p.files.thumb} alt={p.caption ?? ''} />
          {extra > 0 && i === shown.length - 1 ? <span className="kp-more" aria-hidden>+{extra}</span> : null}
        </Link>
      ))}
    </div>
  );
}
