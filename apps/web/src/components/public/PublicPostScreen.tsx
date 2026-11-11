'use client';
// /p/<id>: one PUBLIC post and its public comments, read-only, for anyone with the link (no account needed).
// Everything shown was signed by its author and is checked on this device against the key that came with
// it. Signed-in readers get a button to the post's screen inside the app, where they can like, comment,
// follow and report; everyone else is invited to join.
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { PublicPostCard } from '@/components/explore/PublicPostCard';
import { PostCardSkeleton } from '@/components/posts/PostCard';
import { RelativeTime, RichText } from '@/components/posts/bits';
import { Avatar } from '@/components/ui/Avatar';
import { ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSession } from '@/lib/keys/session';
import { fetchPublicComments, fetchPublicPost, openPublicComment, publicName, type PublicCommentRow } from '@/lib/public/posts';

export function PublicPostScreen({ id }: { id: string }) {
  const t = useT();
  const { status } = useSession();
  const signedIn = status === 'ready' || status === 'locked';
  // The session decides which key the request goes out with; wait until it is known.
  const settled = status !== 'loading';
  const post = useQuery({ queryKey: ['public-post', id], enabled: settled, queryFn: () => fetchPublicPost(id), staleTime: 30_000 });
  const comments = useQuery({ queryKey: ['public-post', id, 'comments'], enabled: settled && !!post.data, queryFn: () => fetchPublicComments(id), staleTime: 30_000 });
  const row = post.data ?? null;
  useDocumentTitle(row ? t('follow.public.pageTitle', { name: publicName(row) }) : t('post.title'));
  return (
    <PublicFrame>
      <div className="k-public-post k-stack">
        {post.isPending ? <PostCardSkeleton /> : !row ? (
          <Card>
            <EmptyState icon="alert" title={t('follow.public.goneTitle')} body={t('follow.public.goneBody')} headingLevel={1}
              actions={<ButtonLink href="/" variant="primary">{t('follow.public.aboutKithwall')}</ButtonLink>} />
          </Card>
        ) : (
          <>
            <h1 className="k-sr-only">{t('follow.public.pageTitle', { name: publicName(row) })}</h1>
            <Callout icon="globe">{t('follow.public.pageNote')}</Callout>
            <PublicPostCard row={row} authorHref={signedIn ? `/u/${row.author_username}` : undefined} />
            {comments.data?.length ? (
              <Card as="section" aria-label={t('feed.commentCount', { count: comments.data.length })}>
                <h2 className="k-section-title">{t('feed.commentCount', { count: comments.data.length })}</h2>
                <ul className="k-comment-list" role="list">
                  {comments.data.map((c) => <li key={c.id}><PublicComment row={c} /></li>)}
                </ul>
              </Card>
            ) : null}
            <Card className="k-public-cta">
              {signedIn ? (
                <>
                  <p>{t('follow.public.openBody')}</p>
                  <ButtonLink href={`/post/${row.id}`} variant="primary">{t('follow.public.openInApp')}</ButtonLink>
                </>
              ) : (
                <>
                  <h2 className="k-card-title">{t('follow.public.joinTitle')}</h2>
                  <p className="k-muted">{t('follow.public.joinBody')}</p>
                  <div className="k-row-wrap">
                    <ButtonLink href="/join" variant="primary">{t('landing.join')}</ButtonLink>
                    <ButtonLink href={`/signin?next=${encodeURIComponent(`/post/${row.id}`)}`} variant="ghost">{t('landing.signIn')}</ButtonLink>
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </div>
    </PublicFrame>
  );
}

function PublicComment({ row }: { row: PublicCommentRow }) {
  const t = useT();
  const d = openPublicComment(row);
  const name = publicName(row);
  return (
    <div className="k-comment">
      <Avatar name={name} size={32} />
      <div className="k-comment-main">
        <div className="k-comment-bubble">
          <span className="k-comment-name">{name}</span>
          {d.ok ? <RichText text={d.value.text} clamp={400} /> : <p className="k-muted k-small">{t('feed.commentHidden')}</p>}
        </div>
        <div className="k-comment-meta k-small">
          <RelativeTime iso={row.created_at} />
          {row.edited_at ? <span className="k-muted">{t('edit.edited')}</span> : null}
        </div>
      </div>
    </div>
  );
}
