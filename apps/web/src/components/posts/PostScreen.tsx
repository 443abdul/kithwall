'use client';
// Post permalink (/post/[id]): one post with its comments open. Activity lines and push
// notifications about a post or comment lead here. Circle posts link back to their circle.
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { PostCard, PostCardSkeleton } from './PostCard';
import { refetchPost } from './data';
import { useCircleName } from './bits';
import { usePostsLive } from './live';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PostScreen({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const { status } = useSession();
  const valid = UUID.test(id);
  usePostsLive();
  const q = useQuery({ queryKey: ['v2feed', 'post', id], enabled: status === 'ready' && valid, queryFn: () => refetchPost(id) });
  const circle = q.data?.group_id ?? null;
  const circleName = useCircleName(circle);
  useDocumentTitle(t('post.title'));
  const back = circle ? { href: `/circles/${circle}`, label: circleName ?? t('nav.circles') } : { href: '/home', label: t('nav.home') };
  return (
    <Page title={t('post.title')} description={circle && circleName ? t('post.inCircle', { name: circleName }) : undefined} back={back}>
      {!valid || (q.isFetched && !q.data) ? (
        <Card>
          <EmptyState icon="alert" title={t('post.gone')} body={t('post.goneBody')}
            actions={<ButtonLink href="/home" variant="primary">{t('nav.home')}</ButtonLink>} />
        </Card>
      ) : q.data ? (
        <PostCard row={q.data} expanded onRemoved={() => router.replace(circle ? `/circles/${circle}` : '/home')} />
      ) : <PostCardSkeleton />}
    </Page>
  );
}
