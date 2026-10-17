'use client';
// List of notes (reference noteList): title, author, date, excerpt. Each note is a post of kind
// "note", decrypted on this device.
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AvatarLink } from '@/components/Avatar';
import { Waiting } from './bits';
import { readPost } from '@/lib/content';
import { indexPost } from '@/lib/feed/feed';
import { people, usePeopleVersion } from '@/lib/people';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { longDate } from '@/lib/format';
import type { PostRow } from '@/lib/types';

export function NoteList({ queryKey, load, empty }: { queryKey: readonly unknown[]; load: (before?: string) => Promise<PostRow[]>; empty: string }) {
  useKeyringVersion();
  usePeopleVersion();
  const { status } = useSession();
  const q = useInfiniteQuery({
    queryKey, enabled: status === 'ready', initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => load(pageParam),
    getNextPageParam: (last) => (last.length >= 20 ? last[last.length - 1]!.created_at : undefined),
  });
  const rows = (q.data?.pages ?? []).flat();
  if (q.isLoading) return <div className="gray kw-pad">Loading notes…</div>;
  if (q.isError) return <div className="err" role="alert">Couldn&rsquo;t load notes.</div>;
  return (
    <div className="list kw-notelist">
      {rows.map((r) => {
        const res = readPost(r);
        const author = people.person(r.author_id);
        if (res.ok) indexPost(r, res.value);
        const n = res.ok ? res.value.note : null;
        return (
          <div className="it" key={r.id}>
            <AvatarLink id={r.author_id} size={50} />
            <div className="d">
              {n ? <Link className="big" href={`/notes/${r.id}`}>{n.title || 'Untitled note'}</Link> : <b className="gray">Note</b>}
              <span className="gray">by {author ? <Link href={`/${author.username}`}>{author.name}</Link> : '…'} &middot; {longDate(r.created_at)}</span>
              {n ? <div style={{ marginTop: 4, color: '#333', overflowWrap: 'anywhere' }}>{n.body.slice(0, 200)}{n.body.length > 200 ? '...' : ''}</div>
                : res.ok ? null : res.reason === 'waiting' ? <Waiting authorId={r.author_id} what="this note" /> : <div className="kw-wait kw-bad">This item couldn&rsquo;t be verified.</div>}
            </div>
          </div>
        );
      })}
      {!rows.length && <div className="gray kw-pad">{empty}</div>}
      {q.hasNextPage && <div className="kw-older"><button type="button" className="kw-link" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}><b>{q.isFetchingNextPage ? 'Loading…' : 'More Notes'}</b></button></div>}
    </div>
  );
}
