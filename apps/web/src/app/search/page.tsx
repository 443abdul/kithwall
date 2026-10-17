'use client';
// Search (reference vSearch). People: usernames and directory names (only people who opted into
// the directory are findable by name), plus your friends' names, matched on this device.
// Posts: searched only on this device, over posts you've already decrypted this session.
import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { PersonRow } from '@/components/social/PersonRow';
import { Story } from '@/components/feed/Story';
import { useFriendIds, useRequests } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { sb } from '@/lib/supabase';
import { sentRequests } from '@/lib/social/graph';
import { fetchPost, searchSession } from '@/lib/feed/feed';
import type { PostRow, ProfileRow } from '@/lib/types';
import '@/styles/social.css';

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSearch(text.trim()); }} style={{ marginBottom: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }} role="search">
      <input type="text" aria-label="Search" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 300, maxWidth: '100%' }} />
      <button className="btn b">Search</button>
    </form>
  );
}

function SearchBody() {
  usePeopleVersion();
  const params = useSearchParams();
  const router = useRouter();
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const { userId, status } = useSession();
  const friends = useFriendIds();
  const reqs = useRequests();
  const sent = useQuery({ queryKey: ['friends', 'sent'], enabled: status === 'ready', queryFn: sentRequests });
  const dir = useQuery({
    queryKey: ['search', 'people', q], enabled: status === 'ready' && q.length >= 2,
    queryFn: async () => {
      // Strip characters with meaning in PostgREST filters / LIKE patterns.
      const term = q.replace(/[%_\\,()"*:]/g, ' ').trim();
      if (term.length < 2) return [];
      const like = `%${term}%`;
      const { data } = await sb().from('profiles').select('*').or(`username.ilike.${like},display_name_public.ilike.${like}`).limit(30);
      const rows = (data ?? []) as ProfileRow[];
      await people.ensure(rows.map((r) => r.id));
      return rows.map((r) => r.id);
    },
  });
  const ql = q.toLowerCase();
  const friendHits = (friends.data ?? []).filter((f) => {
    const p = people.person(f);
    return !!ql && !!p && (p.name.toLowerCase().includes(ql) || p.username.includes(ql));
  });
  const peopleIds = [...new Set([...friendHits, ...(dir.data ?? [])])];
  const fset = new Set(friends.data ?? []);
  const sset = new Set(sent.data ?? []);
  const rset = new Set((reqs.data ?? []).map((r) => r.requested_by));
  const rel = (id: string) => (id === userId ? 'self' : fset.has(id) ? 'friends' : sset.has(id) ? 'sent' : rset.has(id) ? 'received' : 'none') as 'self' | 'friends' | 'sent' | 'received' | 'none';

  const postHits = q.length >= 2 ? searchSession(q, 10) : [];
  const posts = useQuery({
    queryKey: ['search', 'posts', postHits.map((p) => p.id).join(',')], enabled: postHits.length > 0,
    queryFn: async () => (await Promise.all(postHits.map((h) => fetchPost(h.id)))).filter(Boolean) as PostRow[],
  });

  return (
    <>
      <Title icon="mag">{q ? <>Search Results for &ldquo;{q}&rdquo;</> : 'Search'}</Title>
      <SearchForm key={q} initial={q} onSearch={(t) => router.push(`/search?q=${encodeURIComponent(t)}`)} />
      {!q && <p className="gray">Search for people by username, or by name if they&rsquo;ve chosen to be listed in the directory. Your friends and your News Feed posts are searched on your device.</p>}
      {q.length === 1 && <p className="gray">Type at least two characters.</p>}
      {q.length >= 2 && <>
        <div className="sub"><span>People</span></div>
        {dir.isLoading ? <div className="gray">Searching…</div> : peopleIds.length ? (
          <div className="list">{peopleIds.map((id) => <PersonRow key={id} id={id} rel={rel(id)} self={userId} />)}</div>
        ) : <div className="note">No people found. Most people on Kithwall aren&rsquo;t listed in the directory, so try their exact username.</div>}
        <div className="sub"><span>Posts You&rsquo;ve Seen</span><span className="gray small" style={{ fontWeight: 'normal' }}>Searched on this device only</span></div>
        {posts.data?.length ? <div className="stream">{posts.data.map((r) => <Story key={r.id} row={r} />)}</div>
          : <div className="gray">No matching posts from this session. Posts are searchable after they&rsquo;ve been shown in your <Link href="/">News Feed</Link>.</div>}
      </>}
    </>
  );
}

export default function Page() {
  return <AppPage right={<TipsBox />}><Suspense fallback={<div className="gray">Loading…</div>}><SearchBody /></Suspense></AppPage>;
}
