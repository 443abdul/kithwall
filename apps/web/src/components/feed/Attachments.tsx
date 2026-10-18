'use client';
// Story attachments (reference storyHTML): link card, check-in map, note excerpt, life event,
// shared post. Everything rendered here was decrypted on this device.
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { Avatar } from '@/components/Avatar';
import { ExternalLink, MapArt, NameList, hashSeed } from '@/components/social/bits';
import { LinkAttachment } from './MediaAtt';
import { readPost } from '@/lib/content';
import { fetchPost } from '@/lib/feed/feed';
import { usePerson } from '@/lib/people';
import { useKeyringVersion } from '@/lib/hooks';
import type { PostPayload } from '@/lib/types';

/** Link attachment: preview card, or a click-to-play player for known video sites (MediaAtt.tsx). */
export function LinkCard({ link }: { link: NonNullable<PostPayload['link']> }) {
  return <LinkAttachment link={link} />;
}

export function placeHref(place: string) { return `/places/${encodeURIComponent(place.trim().toLowerCase().slice(0, 100))}`; }

export function CheckinAtt({ checkin }: { checkin: NonNullable<PostPayload['checkin']> }) {
  return (
    <div className="att">
      <Link className="th map" href={placeHref(checkin.place)} aria-label={`Map of ${checkin.place}`}>
        <MapArt seed={hashSeed(checkin.place.toLowerCase())} width={120} height={72} label={checkin.place} />
      </Link>
      <div className="ad">
        <Link className="at" href={placeHref(checkin.place)}>{checkin.place}</Link>
        {checkin.address ?? null}
        {typeof checkin.lat === 'number' && typeof checkin.lng === 'number'
          ? <><br /><span className="gray">Near {checkin.lat.toFixed(2)}, {checkin.lng.toFixed(2)}</span></> : null}
      </div>
    </div>
  );
}

export function NoteAtt({ postId, note }: { postId: string; note: NonNullable<PostPayload['note']> }) {
  const body = note.body.length > 220 ? `${note.body.slice(0, 220)}...` : note.body;
  return (
    <div className="att"><div className="ad" style={{ color: '#333' }}>
      {body}{note.body.length > 220 ? <> <Link href={`/notes/${postId}`}>Read more</Link></> : null}
    </div></div>
  );
}

export const LIFE_VERBS: Record<string, string> = {
  engaged: 'is engaged to', married: 'is married to', relationship: 'is in a relationship with', complicated: 'is in a complicated relationship with',
};

export function LifeEventAtt({ ev }: { ev: NonNullable<PostPayload['lifeEvent']> }) {
  return (
    <div className="att"><span className="th kw-bigic">
      <Icon name={ev.kind === 'engaged' || ev.kind === 'married' ? 'ring' : 'heart'} title={ev.title} />
    </span></div>
  );
}

/** A shared (public) post, shown inside the sharer's story. */
export function SharedAtt({ postId }: { postId: string | null }) {
  useKeyringVersion();
  const q = useQuery({ queryKey: ['post', postId], enabled: !!postId, queryFn: () => fetchPost(postId!) });
  const row = q.data;
  const author = usePerson(row?.author_id);
  if (!postId || (!q.isLoading && !row)) return <div className="att gray">This content is no longer available.</div>;
  if (!row) return <div className="att gray">Loading…</div>;
  const r = readPost(row);
  if (!r.ok) return <div className="att gray">{r.reason === 'waiting' ? 'Waiting for the original post to be shared with you.' : 'This item couldn’t be verified.'}</div>;
  const p = r.value;
  const what = p.text || p.link?.title || p.question?.text || p.note?.title || p.checkin?.place || 'Post';
  return (
    <div className="att">
      <Link className="th" href={`/post/${row.id}`} aria-label="Original post"><Avatar id={row.author_id} size={50} /></Link>
      <div className="ad">
        <Link className="at" href={`/post/${row.id}`}>{what.slice(0, 120)}</Link>
        Originally posted by {author ? <Link href={`/${author.username}`}>{author.name}</Link> : '…'}
        {p.link ? <><br /><ExternalLink href={p.link.url}>{p.link.url}</ExternalLink></> : null}
      </div>
    </div>
  );
}

export function WithFriends({ ids }: { ids?: string[] }) {
  if (!ids?.length) return null;
  return <> &mdash; with <NameList ids={ids} max={3} /></>;
}
