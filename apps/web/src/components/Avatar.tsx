'use client';
import Link from 'next/link';
import { usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';

/** Silhouette used when there is no (readable) profile picture — the 2010 default. */
export function Silhouette({ size = 50 }: { size?: number }) {
  return (
    <svg className="av" width={size} height={size} viewBox="0 0 50 50" aria-hidden>
      <rect width="50" height="50" fill="#e9ebee" />
      <circle cx="25" cy="19" r="9" fill="#c3c9d6" />
      <path d="M7 50c0-11 8-17 18-17s18 6 18 17z" fill="#c3c9d6" />
    </svg>
  );
}

export function Avatar({ id, size = 50, big = false }: { id: string; size?: number; big?: boolean }) {
  const p = usePerson(id);
  const ref = big ? p?.info?.avatar?.med : p?.info?.avatar?.thumb;
  const url = useFileUrl(ref);
  if (!url) return <Silhouette size={size} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="av" src={url} width={size} height={size} style={{ objectFit: 'cover' }} alt={p ? `${p.name}` : ''} />;
}

export function AvatarLink({ id, size = 50 }: { id: string; size?: number }) {
  const p = usePerson(id);
  return (
    <Link className="avl" href={p ? `/${p.username}` : '#'} aria-label={p?.name ?? 'Profile'}>
      <Avatar id={id} size={size} />
    </Link>
  );
}

export function NameLink({ id, bold = true }: { id: string; bold?: boolean }) {
  const p = usePerson(id);
  if (!p) return <span className="gray">…</span>;
  const n = <Link href={`/${p.username}`}>{p.name}</Link>;
  return bold ? <b>{n}</b> : n;
}
