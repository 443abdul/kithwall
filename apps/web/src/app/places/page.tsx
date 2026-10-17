'use client';
// Places (reference vPlaces): check in, and see where friends recently checked in.
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { Icon } from '@/components/Icon';
import { Stream, pageOf } from '@/components/feed/Stream';
import { placeHref } from '@/components/feed/Attachments';
import { MapArt, hashSeed } from '@/components/social/bits';
import { CheckIn } from '@/components/social/CheckIn';
import { useAuthors } from '@/components/social/useAuthors';
import { readPost } from '@/lib/content';
import { fetchByKind } from '@/lib/feed/feed';
import { useKeyringVersion } from '@/lib/hooks';
import type { PostRow } from '@/lib/types';
import { useQuery } from '@tanstack/react-query';
import '@/styles/social.css';

function Places() {
  const authors = useAuthors();
  return (
    <>
      <Title icon="place">Places</Title>
      <div className="note"><Icon name="place" /> <b>Share where you are</b> with your friends. Check-ins are encrypted like everything else,
        and your location is only used when you press &ldquo;Use my location&rdquo;.</div>
      <CheckIn />
      <div className="sub"><span>Friends Recently Checked In</span></div>
      {authors ? <Stream queryKey={['kind', 'checkin', 'friends']} load={async (b) => pageOf(await fetchByKind('checkin', authors, b), 20)}
        empty="None of your friends have checked in yet." /> : <div className="gray">Loading…</div>}
    </>
  );
}

/** "Recent Places" from check-ins already decrypted on this device. */
function RecentPlaces() {
  useKeyringVersion();
  const qc = useQueryClient();
  const authors = useAuthors();
  // Re-read whatever the stream loaded (same query key) without another fetch.
  const q = useQuery({
    queryKey: ['kind', 'checkin', 'friends', 'places'], enabled: !!authors, staleTime: 60_000,
    queryFn: async () => {
      const cached = qc.getQueryData<{ pages: { rows: PostRow[] }[] }>(['kind', 'checkin', 'friends']);
      return cached?.pages.flatMap((p) => p.rows) ?? (await fetchByKind('checkin', authors!, undefined, 40));
    },
  });
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of q.data ?? []) {
    const res = readPost(r);
    const pl = res.ok ? res.value.checkin?.place : undefined;
    if (!pl) continue;
    const k = pl.trim().toLowerCase();
    counts.set(k, { name: counts.get(k)?.name ?? pl, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  const list = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  if (!list.length) return null;
  return (
    <RightBox title="Popular With Friends">
      {list.map((p) => (
        <div className="rr" key={p.name}>
          <Link className="avl map" href={placeHref(p.name)} aria-label={p.name}><MapArt seed={hashSeed(p.name.toLowerCase())} width={40} height={40} /></Link>
          <div><Link href={placeHref(p.name)}>{p.name}</Link><br /><span className="gray">{p.n} check-in{p.n > 1 ? 's' : ''}</span></div>
        </div>
      ))}
    </RightBox>
  );
}

export default function Page() {
  return <AppPage active="places" right={<><RecentPlaces /><TipsBox n={1} /></>}><Places /></AppPage>;
}
