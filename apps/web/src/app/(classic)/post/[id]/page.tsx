'use client';
// Post permalink (reference vPost): one story with all comments shown and the comment box open.
import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AppPage } from '@/components/Shell';
import { Story } from '@/components/feed/Story';
import { TipsBox } from '@/components/feed/RightColumn';
import { fetchPost } from '@/lib/feed/feed';
import { useSession } from '@/lib/keys/session';
import '@/styles/social.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PostView({ id }: { id: string }) {
  const { status } = useSession();
  const q = useQuery({ queryKey: ['post', id], enabled: status === 'ready' && UUID.test(id), queryFn: () => fetchPost(id) });
  if (!UUID.test(id) || (!q.isLoading && !q.data)) {
    return <div className="note">This content is no longer available. It may have been deleted, or you may not have permission to see it. <Link href="/">Go to your News Feed</Link></div>;
  }
  if (!q.data) return <div className="gray kw-pad">Loading…</div>;
  return <div className="stream"><Story row={q.data} expanded /></div>;
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AppPage active="home" right={<TipsBox />}><PostView id={id} /></AppPage>;
}
