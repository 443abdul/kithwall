'use client';
// One PUBLIC post, as shown in Explore and behind its shareable link (docs/v2/10-follow-public.md §4). It
// works without an account: the author's handle, public name and signing key come with the post, the
// signature is checked on this device before anything is shown, and photos and videos are fetched and opened
// with the keys the post itself carries. Always labelled Public. Liking, commenting and reporting happen on
// the post's own screen inside the app (`href`), which loads the author into the reader's people directory.
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useFormat, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { AutomatedBadge } from '@/components/official/Automated';
import { RelativeTime } from '@/components/posts/bits';
import { Lightbox } from '@/components/posts/Media';
import { PostBody } from '@/components/posts/PostCard';
import { payloadText } from '@/lib/feed/feed';
import { openPublicPost, publicName, type PublicPostRow } from '@/lib/public/posts';
import { matchesHidden } from '@/lib/social/hiddenWords';

export function PublicTag() {
  const t = useT();
  return <span className="k-aud k-aud-public" title={t('follow.public.tagTitle')}><Icon name="globe" /><span className="k-aud-label">{t('feed.audiencePublic')}</span></span>;
}

export function PublicPostCard({ row, href, authorHref, hiddenWords, footer }: {
  row: PublicPostRow;
  /** Where the card's "open" link leads (the in-app post screen, or the public link). */
  href?: string;
  /** The author's profile, for signed-in readers. */
  authorHref?: string;
  /** My hidden words (signed-in readers): a matching post is folded away. */
  hiddenWords?: readonly string[];
  footer?: ReactNode;
}) {
  const t = useT();
  const f = useFormat();
  const d = useMemo(() => openPublicPost(row), [row]);
  const [photo, setPhoto] = useState<number | null>(null);
  const [unfold, setUnfold] = useState(false);
  const name = publicName(row);
  const photos = d.ok ? d.value.photos ?? [] : [];
  if (d.ok && !unfold && hiddenWords?.length && matchesHidden(payloadText(d.value), hiddenWords)) {
    return (
      <Card as="article" className="k-post k-post-filtered" aria-label={name}>
        <p className="k-muted k-small"><Icon name="eyeOff" /> {t('hidden.post')} <button type="button" className="k-linkbtn" onClick={() => setUnfold(true)}>{t('hidden.show')}</button></p>
      </Card>
    );
  }
  return (
    <Card as="article" className="k-post k-post-public" aria-label={name}>
      <header className="k-post-head">
        {authorHref ? <Link href={authorHref} className="k-post-av" tabIndex={-1} aria-hidden><Avatar name={name} size={44} /></Link> : <Avatar name={name} size={44} />}
        <div className="k-post-who">
          {authorHref ? <Link href={authorHref} className="k-post-name">{name}</Link> : <span className="k-post-name">{name}</span>}
          <span className="k-post-meta">
            <span className="k-ltr">@{row.author_username}</span>
            <AutomatedBadge userId={row.author_id} />
            <span aria-hidden>·</span>
            <RelativeTime iso={row.created_at} />
            {row.edited_at ? <span className="k-muted">· {t('feed.edited')}</span> : null}
            <span aria-hidden>·</span>
            <PublicTag />
          </span>
        </div>
      </header>
      {d.ok
        ? <PostBody payload={d.value} onOpenMedia={photos.length ? (i) => { if (i < photos.length) setPhoto(i); } : undefined} />
        : <p className="k-post-waiting k-muted k-small"><Icon name="alert" /> {t('feed.unverified')}</p>}
      <div className="k-public-foot k-small">
        <span className="k-muted"><Icon name="heart" /> {f.number(row.like_count)}</span>
        <span className="k-muted"><Icon name="comment" /> {f.number(row.comment_count)}</span>
        <span className="k-spacer" />
        {href ? <Link href={href} className="k-linkbtn">{t('explore.open')}</Link> : null}
      </div>
      {footer}
      {photo !== null && photos.length ? <Lightbox photos={photos} index={photo} onClose={() => setPhoto(null)} /> : null}
    </Card>
  );
}
