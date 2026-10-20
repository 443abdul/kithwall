'use client';
// A place (reference vPlace): map art, "Check In Here", recent check-ins by friends at this place
// (matched by name on this device — places aren't stored on the server), people who were here.
import { use, useCallback, useState } from 'react';
import Link from 'next/link';
import { AppPage, RightBox } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { Icon } from '@/components/Icon';
import { Stream, type StreamPage } from '@/components/feed/Stream';
import { MapArt, NameList, hashSeed } from '@/components/social/bits';
import { CheckIn } from '@/components/social/CheckIn';
import { useAuthors } from '@/components/social/useAuthors';
import { readPost } from '@/lib/content';
import { fetchByKind } from '@/lib/feed/feed';
import type { PostRow } from '@/lib/types';
import '@/styles/social.css';

const PAGES = 5;

function Place({ slug }: { slug: string }) {
  const key = slug.trim().toLowerCase();
  const authors = useAuthors();
  const [checkin, setCheckin] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [display, setDisplay] = useState(slug);

  // Load up to 100 recent check-ins from me and my friends, then keep those at this place.
  const load = useCallback(async (before?: string): Promise<StreamPage> => {
    const out: PostRow[] = [];
    let cursor = before;
    for (let i = 0; i < PAGES; i++) {
      const rows = await fetchByKind('checkin', authors!, cursor, 20);
      out.push(...rows);
      if (rows.length < 20) return { rows: out };
      cursor = rows[rows.length - 1]!.created_at;
    }
    return { rows: out, next: cursor };
  }, [authors]);
  const arrange = useCallback((rows: PostRow[]) => {
    const here = rows.filter((r) => {
      const x = readPost(r);
      return x.ok && x.value.checkin?.place.trim().toLowerCase() === key;
    });
    return here;
  }, [key]);
  const onRows = useCallback((here: PostRow[]) => {
    const ids = new Set<string>();
    for (const r of here) {
      const x = readPost(r);
      ids.add(r.author_id);
      if (x.ok) x.value.checkin?.with?.forEach((w) => ids.add(w));
      if (x.ok && x.value.checkin) setDisplay(x.value.checkin.place);
    }
    setPeople([...ids]);
  }, []);

  return (
    <>
      <div className="map" style={{ marginBottom: 10 }}><MapArt seed={hashSeed(key)} width="100%" height={180} label={display} /></div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div><h2 style={{ fontSize: 16, color: '#1c2a47' }}>{display}</h2><Link href="/places" className="small">Back to Places</Link></div>
        <button type="button" className="btn b" onClick={() => setCheckin((v) => !v)}><Icon name="place" /> Check In Here</button>
      </div>
      {checkin && <CheckIn initialPlace={display} />}
      {people.length > 0 && <p className="gray" style={{ marginBottom: 8 }}>People who were here: <NameList ids={people} max={8} /></p>}
      <div className="sub"><span>Recent Activity</span></div>
      {authors ? <Stream queryKey={['kind', 'checkin', 'place', key]} load={load} arrange={arrange} onRows={onRows} empty="None of your friends have checked in here recently." />
        : <div className="gray">Loading…</div>}
    </>
  );
}

export default function Page({ params }: { params: Promise<{ place: string }> }) {
  const { place } = use(params);
  let slug = place;
  try { slug = decodeURIComponent(place); } catch { /* keep raw */ }
  return <AppPage active="places" right={<><RightBox title="About Places"><p className="gray">Places are just names you and your friends type. Kithwall never stores your location on its servers.</p></RightBox><TipsBox n={1} /></>}>
    <Place slug={slug.slice(0, 100)} />
  </AppPage>;
}
