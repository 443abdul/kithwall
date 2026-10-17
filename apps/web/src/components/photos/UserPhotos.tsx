'use client';
// /[username]/photos — "Photos of {Name}" (tagged photos I can read) + their albums I can read.
import '@/styles/photos.css';
import Link from 'next/link';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { useSession } from '@/lib/keys/session';
import { people, usePerson } from '@/lib/people';
import { listAlbums, readPhoto, taggedPhotos } from '@/lib/photos';
import { AlbumGrid, PhotoThumbGrid } from './Albums';
import { errText, useKeysReady } from './common';

export function UserPhotos({ username }: { username: string }) {
  const ready = useKeysReady();
  const { userId } = useSession();
  const prof = useQuery({ queryKey: ['photos', 'user', username.toLowerCase()], enabled: ready, queryFn: () => people.byUsername(username) });
  const uid = prof.data?.id;
  const person = usePerson(uid);
  const isMe = uid === userId;
  const tagged = useQuery({ queryKey: ['photos', 'tagged', uid, 'all'], enabled: ready && !!uid, queryFn: () => taggedPhotos(uid!, 60) });
  const albums = useQuery({ queryKey: ['photos', 'albums', 'owner', uid], enabled: ready && !!uid, queryFn: () => listAlbums({ ownerId: uid!, limit: 200 }) });
  const first = person ? person.name.split(' ')[0] : username;
  useEffect(() => { document.title = `${person?.name ?? username}'s Photos | Kithwall`; }, [person, username]);

  if (!ready || prof.isLoading) return <AppPage active="photos"><div className="gray">Loading…</div></AppPage>;
  if (prof.error) return <AppPage active="photos"><div className="err">{errText(prof.error)}</div></AppPage>;
  if (!prof.data) return <AppPage active="photos"><div className="note">This profile could not be found.</div></AppPage>;
  const taggedRows = (tagged.data ?? []).filter((r) => readPhoto(r).ok);

  return (
    <AppPage active="photos">
      <Title icon="photo" right={<Link href={`/${prof.data.username}`}>Back to {isMe ? 'My Profile' : `${first}’s Profile`}</Link>}>
        {isMe ? 'My Photos' : `${person?.name ?? username}’s Photos`}
      </Title>
      <div className="sub"><span>Photos of {isMe ? 'Me' : first} <span className="gray">({taggedRows.length})</span></span></div>
      {tagged.isLoading ? <div className="gray">Loading…</div> : <PhotoThumbGrid rows={taggedRows} empty={isMe ? 'No one has tagged you in a photo yet.' : 'No photos.'} />}
      <div className="sub">
        <span>{isMe ? 'My' : `${first}’s`} Albums <span className="gray">({albums.data?.length ?? 0})</span></span>
        {isMe ? <Link href="/photos/new">+ Create a Photo Album</Link> : null}
      </div>
      {albums.isLoading ? <div className="gray">Loading…</div> : <AlbumGrid albums={albums.data ?? []} empty="No albums." />}
    </AppPage>
  );
}
