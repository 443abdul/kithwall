'use client';
// Reposts. A share is my own post (kind 'share') that points at the original by id and carries only what
// I wrote: the original's content is never copied into it. Each reader's device loads the original
// through the database's normal rules, so someone who couldn't see the original still can't; they see
// "not available" instead. Sharing never widens who can read anyone else's post.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { createPost, readPost } from '@/lib/content';
import { useKeyringVersion } from '@/lib/hooks';
import { usePeopleVersion, usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import { notifySafe } from '@/lib/feed/feed';
import type { PostRow } from '@/lib/types';
import type { ComposerAudience } from '.';
import { AudienceOptions, resolve, useMyCircles } from './Composer';
import { refetchPost } from './data';
import { RelativeTime } from './bits';
import { PostBody } from './PostCard';

/** The original post inside a share (one level: a share of a share shows that share's own words). */
export function SharedPost({ id }: { id: string }) {
  const t = useT();
  useKeyringVersion();
  usePeopleVersion();
  const q = useQuery({ queryKey: ['shared-post', id], queryFn: () => refetchPost(id), staleTime: 60_000 });
  const row = q.data ?? null;
  const author = usePerson(row?.author_id);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  if (q.isPending) return <div className="k-shared k-muted k-small">…</div>;
  const d = row ? readPost(row) : null;
  if (!row || !d?.ok) {
    return <div className="k-shared k-shared-gone k-small k-muted"><Icon name="lock" /> {t('share.unavailable')}</div>;
  }
  return (
    <div className="k-shared">
      <div className="k-shared-head">
        <Avatar name={author?.name ?? ''} src={avatar} size={28} />
        <span className="k-shared-who">
          {author ? <Link href={`/u/${author.username}`} className="k-post-name">{author.name}</Link> : <span>…</span>}
          <span className="k-small k-muted"> · <RelativeTime iso={row.created_at} /></span>
        </span>
        <Link href={`/post/${row.id}`} className="k-small">{t('share.open')}</Link>
      </div>
      <PostBody payload={d.value} row={row} nested />
    </div>
  );
}

export function ShareDialog({ row, onClose }: { row: PostRow; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const circles = useMyCircles(true);
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<ComposerAudience>({ kind: 'connections' });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = audience.kind === 'connections' ? t('feed.toConnections') : audience.kind === 'close' ? t('close.audience')
    : audience.kind === 'only_me' ? t('feed.toOnlyMe') : audience.kind === 'circle' ? circles.find((c) => c.id === audience.circleId)?.name ?? t('feed.audienceCircle') : t('feed.audienceEvent');
  async function share() {
    setBusy(true);
    try {
      const r = await resolve(audience);
      const body = text.trim().slice(0, 8000);
      await createPost({ kind: 'share', payload: body ? { text: body } : {}, sharedPostId: row.shared_post_id ?? row.id, ...r });
      // The original's author hears about it (a share of a share points at the original, whose author we may not know).
      if (audience.kind === 'connections' && row.kind !== 'share') await notifySafe(row.author_id, 'share', 'post', row.id);
      await qc.invalidateQueries({ queryKey: ['v2feed'] });
      toast({ message: t('share.done') });
      onClose();
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={onClose} title={t('share.title')} sheet dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('feed.cancel')}</Button>
        <Button variant="primary" onClick={() => void share()} busy={busy}>{t('share.submit')}</Button>
      </>}>
      <div className="k-stack">
        <Textarea label={t('share.say')} value={text} rows={3} maxLength={8000} dir="auto" onChange={(e) => setText(e.target.value)} />
        <div className="k-row">
          <span className="k-label">{t('stories.audience')}</span>
          <button type="button" className="k-chip k-chip-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}>
            <span>{label}</span><Icon name="down" />
          </button>
        </div>
        <SharedPost id={row.shared_post_id ?? row.id} />
        <p className="k-small k-muted"><Icon name="lock" /> {t('share.note')}</p>
      </div>
      <Dialog open={picking} onClose={() => setPicking(false)} title={t('stories.audience')} sheet>
        <AudienceOptions value={audience} circles={circles} onPick={(a) => { setAudience(a); setPicking(false); }} />
      </Dialog>
    </Dialog>
  );
}
