'use client';
// "Saved" (You → Saved): posts I bookmarked. The list is in my encrypted vault (lib/social/prefs); each post
// is still loaded through the normal rules, so one I can no longer see simply drops out.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { preparePosts } from '@/lib/content';
import { useSession } from '@/lib/keys/session';
import { sb, must } from '@/lib/supabase';
import { loadSocialPrefs, useSocialPrefs } from '@/lib/social/prefs';
import type { PostRow } from '@/lib/types';
import { rememberAudienceKinds } from './data';
import { PostCard } from './PostCard';

export function SavedScreen() {
  const t = useT();
  const { status } = useSession();
  const prefs = useSocialPrefs();
  useDocumentTitle(t('saved.title'));
  useEffect(() => { if (status === 'ready') void loadSocialPrefs().catch(() => undefined); }, [status]);
  const ids = prefs.saved.map((s) => s.id);
  const q = useQuery({
    queryKey: ['saved-posts', ids.join(',')], enabled: status === 'ready' && prefs.loaded,
    queryFn: async () => {
      const rows: PostRow[] = [];
      for (let i = 0; i < ids.length; i += 100) rows.push(...(must(await sb().from('posts').select('*').in('id', ids.slice(i, i + 100))) as PostRow[]));
      await preparePosts(rows);
      await rememberAudienceKinds(rows);
      const order = new Map(ids.map((id, i) => [id, i]));
      return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    },
  });
  return (
    <Page title={t('saved.title')} description={t('saved.sub')} back={{ href: '/you', label: t('nav.you') }}>
      {!prefs.loaded || q.isPending ? <div className="k-center"><Spinner /></div>
        : q.data?.length ? <div className="k-feed">{q.data.map((r) => <PostCard key={r.id} row={r} />)}</div>
        : <Card><EmptyState icon="book" title={t('saved.emptyTitle')} body={t('saved.emptyBody')} /></Card>}
    </Page>
  );
}
