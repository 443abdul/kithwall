'use client';
// You → Kit Drop (lib/social/kitdrop): posts written offline waiting to go out, making a signed Kit Drop
// file to pass on without the internet, and opening ones received from others (checked and decrypted on
// this device; only posts this person could see on Kithwall anyway are shown).
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFormat, useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { readPost } from '@/lib/content';
import { saveBlob } from '@/lib/export';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { isHeld, useFileUrl } from '@/lib/media';
import { isNative } from '@/lib/native';
import { usePeopleVersion, usePerson } from '@/lib/people';
import {
  dropOutboxItem, flushOutbox, forgetKitDrop, KITDROP_MIME, makeKitDrop, openKitDrop, outboxItems, receivedKitDrops, type OpenedKitDrop,
} from '@/lib/social/kitdrop';
import type { PostPayload, PostRow } from '@/lib/types';
import { RelativeTime } from './bits';
import { PostBody } from './PostCard';

/** Posts already loaded on this device (the feeds in memory), newest first. */
function postsInMemory(qc: ReturnType<typeof useQueryClient>, days: number): PostRow[] {
  const since = Date.now() - days * 86_400_000;
  const out = new Map<string, PostRow>();
  for (const [, data] of qc.getQueriesData<InfiniteData<{ rows: PostRow[] }>>({ queryKey: ['v2feed'] })) {
    for (const page of data?.pages ?? []) for (const r of page?.rows ?? []) if (r?.id && Date.parse(r.created_at) >= since) out.set(r.id, r);
  }
  return [...out.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** `entry="offline"`: shown by the offline entry point (/offline, components/net/OfflineShell) with its `notice`. */
export function KitDropScreen({ notice, entry }: { notice?: ReactNode; entry?: 'offline' } = {}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { status } = useSession();
  const incoming = useSearchParams()?.get('incoming') ?? '';
  useKeyringVersion();
  usePeopleVersion();
  useDocumentTitle(t('kitdrop.title'));
  const outbox = useQuery({ queryKey: ['kitdrop-outbox'], enabled: status === 'ready', queryFn: outboxItems });
  const inbox = useQuery({ queryKey: ['kitdrop-inbox'], enabled: status === 'ready', queryFn: receivedKitDrops });
  const [withRecent, setWithRecent] = useState(true);
  const [busy, setBusy] = useState<null | 'make' | 'open' | 'send'>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recent = withRecent ? postsInMemory(qc, 3) : [];
  const waiting = outbox.data ?? [];

  async function make() {
    setBusy('make');
    try {
      const { blob, count, name, photos, photosLeft, videos } = await makeKitDrop(recent);
      if (!count) { toast({ message: t('kitdrop.nothing') }); return; }
      saveBlob(blob, name);
      toast({ message: [
        t('kitdrop.saved', { count }),
        photos ? t('kitdrop.savedPhotos', { count: photos }) : '',
        photosLeft ? t('kitdrop.photosLeft', { count: photosLeft }) : '',
        videos ? t('kitdrop.videosLeft', { count: videos }) : '',
      ].filter(Boolean).join(' ') });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(null); }
  }
  async function open(f: File | undefined) {
    if (fileInput.current) fileInput.current.value = '';
    if (!f) return;
    setBusy('open');
    try {
      const k = await openKitDrop(f);
      await qc.invalidateQueries({ queryKey: ['kitdrop-inbox'] });
      toast({ message: k.verified ? t('kitdrop.opened', { count: k.posts.length }) : t('kitdrop.unverified'), tone: k.verified ? undefined : 'danger' });
    } catch (e) {
      toast({ message: (e as Error).message === 'too_big' ? t('kitdrop.tooBig') : t('kitdrop.notKitdrop'), tone: 'danger' });
    } finally { setBusy(null); }
  }
  // A Kit Drop file opened in Kithwall from outside: handed over by the Android app (share sheet, "Open
  // with", Quick Share; lib/native/kitdrop), or by an installed web app (manifest file_handlers).
  const openFile = useEffectEvent((f: File) => { void open(f); });
  const refuse = useEffectEvent((e: unknown) => {
    toast({ message: (e as Error).message === 'too_big' ? t('kitdrop.tooBig') : t('kitdrop.notKitdrop'), tone: 'danger' });
  });
  useEffect(() => {
    if (status !== 'ready' || !isNative()) return;
    let live = true;
    void import('@/lib/native/kitdrop').then((m) => m.takeIncomingKitDrop())
      .then((f) => { if (f && live) openFile(f); })
      .catch((e) => { if (live) refuse(e); });
    return () => { live = false; };
  }, [status, incoming]);
  useEffect(() => {
    const lq = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files?: readonly FileSystemFileHandle[] }) => void): void } }).launchQueue;
    if (status !== 'ready' || !lq) return;
    lq.setConsumer((p) => { for (const h of p.files ?? []) void h.getFile().then((f) => openFile(f)).catch(() => undefined); });
  }, [status]);

  async function sendNow() {
    setBusy('send');
    try {
      const n = await flushOutbox();
      await qc.invalidateQueries({ queryKey: ['kitdrop-outbox'] });
      if (n) { void qc.invalidateQueries({ queryKey: ['v2feed'] }); toast({ message: t('kitdrop.sent', { count: n }) }); }
      else toast({ message: t('kitdrop.stillOffline'), tone: 'danger' });
    } finally { setBusy(null); }
  }

  return (
    <Page title={t('kitdrop.title')} description={t('kitdrop.sub')} back={entry === 'offline' ? undefined : { href: '/you', label: t('nav.you') }}>
      {notice}
      <Card>
        <div className="k-stack">
          <h2 className="k-section-title"><Icon name="clock" /> {t('kitdrop.waitingTitle')}</h2>
          {waiting.length ? (
            <>
              <ul className="k-kd-list" role="list">
                {waiting.map((w) => (
                  <li key={w.id} className="k-kd-item">
                    <KitPost row={{ ...(w.post as PostRow), created_at: w.queuedAt, edited_at: null }} />
                    <Button size="sm" variant="ghost" onClick={() => void dropOutboxItem(w.id).then(() => qc.invalidateQueries({ queryKey: ['kitdrop-outbox'] }))}>{t('kitdrop.discard')}</Button>
                  </li>
                ))}
              </ul>
              <div><Button size="sm" variant="primary" icon="send" busy={busy === 'send'} onClick={() => void sendNow()}>{t('kitdrop.sendNow')}</Button></div>
            </>
          ) : <p className="k-muted k-small">{t('kitdrop.waitingNone')}</p>}
          <p className="k-muted k-xs"><Icon name="image" /> {t('kitdrop.waitingMedia')}</p>
        </div>
      </Card>

      <Card>
        <div className="k-stack">
          <h2 className="k-section-title"><Icon name="download" /> {t('kitdrop.makeTitle')}</h2>
          <p className="k-small">{t('kitdrop.makeBody')}</p>
          <p className="k-small k-muted">{t('kitdrop.mediaNote')}</p>
          <Switch checked={withRecent} label={t('kitdrop.withRecent')} description={t('kitdrop.withRecentBody', { count: postsInMemory(qc, 3).length })} onChange={setWithRecent} />
          <div><Button variant="primary" icon="download" busy={busy === 'make'} onClick={() => void make()}>{t('kitdrop.make', { count: waiting.length + recent.length })}</Button></div>
          <Callout>{t('kitdrop.howToPass')}</Callout>
        </div>
      </Card>

      <Card>
        <div className="k-stack">
          <h2 className="k-section-title"><Icon name="share" /> {t('kitdrop.openTitle')}</h2>
          <input ref={fileInput} type="file" accept={isNative() ? undefined : `.kwd,${KITDROP_MIME},application/json`} hidden onChange={(e) => void open(e.target.files?.[0])} />
          <div><Button variant="soft" icon="plus" busy={busy === 'open'} onClick={() => fileInput.current?.click()}>{t('kitdrop.open')}</Button></div>
          <p className="k-small k-muted"><Icon name="lock" /> {t('kitdrop.openBody')}</p>
        </div>
      </Card>

      {inbox.data?.length ? inbox.data.map((k) => <Received key={k.id} k={k} onForget={() => void forgetKitDrop(k.id).then(() => qc.invalidateQueries({ queryKey: ['kitdrop-inbox'] }))} />)
        : <Card><EmptyState icon="share" title={t('kitdrop.inboxEmpty')} body={t('kitdrop.inboxEmptyBody')} /></Card>}
    </Page>
  );
}

function Received({ k, onForget }: { k: OpenedKitDrop; onForget: () => void }) {
  const t = useT();
  const f = useFormat();
  const from = usePerson(k.from);
  const readable = k.posts.filter((p) => readPost(p).ok);
  return (
    <Card>
      <div className="k-stack">
        <div className="k-row">
          <span className="k-kd-from">
            {k.verified ? <Icon name="shield" /> : <Icon name="alert" />}
            {t(k.verified ? 'kitdrop.fromVerified' : 'kitdrop.fromUnverified', { name: from?.name ?? '…', when: f.date(new Date(k.made), { dateStyle: 'medium', timeStyle: 'short' }) })}
          </span>
          <span className="k-spacer" />
          <Button size="sm" variant="ghost" icon="trash" onClick={onForget}>{t('kitdrop.forget')}</Button>
        </div>
        <p className="k-small k-muted">{t('kitdrop.readableCount', { count: readable.length, total: k.posts.length })}</p>
        <ul className="k-kd-list" role="list">
          {readable.map((p) => <li key={p.id} className="k-kd-item"><KitPost row={p} /></li>)}
        </ul>
      </div>
    </Card>
  );
}

/**
 * Photos carried in a Kit Drop file are held on this device in the medium size only: show that copy wherever
 * this post would use another size, so they appear without the internet.
 */
function withHeldPhotos(payload: PostPayload): PostPayload {
  if (!payload.photos?.length) return payload;
  return {
    ...payload,
    photos: payload.photos.map((p) => (isHeld(p.files?.med?.path) && !isHeld(p.files.big?.path)
      ? { ...p, files: { big: p.files.med, med: p.files.med, thumb: p.files.med } } : p)),
  };
}

/** A post from a Kit Drop or the outbox: who, when, and the content (no actions: they need the internet). */
function KitPost({ row }: { row: PostRow }) {
  const t = useT();
  const author = usePerson(row.author_id);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const d = readPost(row);
  if (!d.ok) return null;
  return (
    <article className="k-kd-post">
      <header className="k-row">
        <Avatar name={author?.name ?? ''} src={avatar} size={32} />
        <span className="k-kd-who"><b>{author?.name ?? '…'}</b> <span className="k-small k-muted"><RelativeTime iso={row.created_at} /></span></span>
      </header>
      <PostBody payload={withHeldPhotos(d.value)} nested />
      {d.value.video ? <p className="k-muted k-xs"><Icon name="video" /> {t('kitdrop.noVideo')}</p> : null}
    </article>
  );
}
