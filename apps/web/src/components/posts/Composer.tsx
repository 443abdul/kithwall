'use client';
// The composer: text (with automatic link previews through the no-log proxy), photos, one video, and an
// audience picker (connections / a circle / only me). Everything is built into a payload and encrypted on
// this device (lib/content createPost); photos and videos are re-encoded / encrypted before upload, with
// progress shown while they go up. Phase 3: an optional disappearing timer and a publish time (scheduled
// posts wait, sealed and visible only to their author, until then).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormat, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { createPost, type Audience } from '@/lib/content';
import { clean, linkPostMedia } from '@/lib/feed/feed';
import { firstUrl } from '@/lib/feed/linkMeta';
import { loadLinkDraft, normalizeUrl, toPayloadLink, uploadPreparedImage, type LinkDraft } from '@/lib/feed/linkPreview';
import { getGroup, groupAudience, listGroups, myMemberships, readGroup } from '@/lib/groups';
import { useKeyringVersion } from '@/lib/hooks';
import { KeyWaitingError } from '@/lib/keys/keyring';
import { useSession } from '@/lib/keys/session';
import { deleteMedia, MAX_PHOTO_BYTES, photoPaths, uploadPhoto } from '@/lib/media';
import { sb, must } from '@/lib/supabase';
import { useMe } from '@/components/shell/AppShell';
import type { PostKind, PostPayload } from '@/lib/types';
import type { ComposerAudience, ComposerProps } from '.';
import { formatBytes, formatDuration } from './bits';
import { LinkCard } from './Media';
import { MAX_VIDEO_BYTES, probeVideo, uploadVideo, videoMime, type VideoProbe } from './video';
import { PostOptionChips, PostOptionsDialog, scheduleProblemKey, useWhen, type PostOptionsValue } from './PostOptions';
import { checkSchedule } from '@/lib/chat/ephemeral';

const MAX_TEXT = 8000;
const MAX_PHOTOS = 10;

interface Picked { id: string; file: File; url: string }

/** Circles I'm an active member of, with their (decrypted) names. */
export function useMyCircles(enabled = true) {
  useKeyringVersion();
  const q = useQuery({
    queryKey: ['my-circles'], enabled, staleTime: 60_000,
    queryFn: async () => {
      const [groups, mem] = await Promise.all([listGroups(), myMemberships()]);
      const active = new Set(mem.filter((m) => m.status === 'active').map((m) => m.audience_id));
      return groups.filter((g) => active.has(g.audience_id));
    },
  });
  return (q.data ?? []).map((g) => {
    const d = readGroup(g);
    return { id: g.id, name: d.ok ? d.value.name : g.name_public ?? '…', row: g };
  });
}

async function resolve(a: ComposerAudience): Promise<{ audience: Audience; groupId?: string; eventId?: string }> {
  switch (a.kind) {
    case 'connections': return { audience: { kind: 'friends' } };
    case 'only_me': return { audience: { kind: 'self' } };
    case 'circle': {
      const g = await getGroup(a.circleId);
      if (!g) throw new Error('circle');
      return { audience: groupAudience(g), groupId: g.id };
    }
    case 'event': {
      const e = must(await sb().from('events').select('id, audience_id, is_public').eq('id', a.eventId).single()) as { id: string; audience_id: string; is_public: boolean };
      return { audience: e.is_public ? { kind: 'public' } : { kind: 'audience', id: e.audience_id }, eventId: e.id };
    }
  }
}

export function Composer({ audience: initial, fixedAudience, placeholder, onPosted }: ComposerProps) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const { userId } = useSession();
  const textId = useId();
  const [text, setText] = useState('');
  const [audience, setAudience] = useState<ComposerAudience>(initial);
  const [picking, setPicking] = useState(false);
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [video, setVideo] = useState<{ file: File; probe: VideoProbe | null; poster: string | null } | null>(null);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; pct?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const skip = useRef(new Set<string>());
  const req = useRef<{ url: string; ac: AbortController; p: Promise<LinkDraft | null> } | null>(null);
  const pasted = useRef(false);
  const circles = useMyCircles(!fixedAudience);
  const router = useRouter();
  const when = useWhen();
  const [options, setOptions] = useState<PostOptionsValue>({ disappear: null, schedule: null });
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Follow a changed `audience` prop (compared by value: callers pass object literals).
  const initialKey = JSON.stringify(initial);
  const [seenKey, setSeenKey] = useState(initialKey);
  if (seenKey !== initialKey) { setSeenKey(initialKey); setAudience(initial); }

  // Automatic link preview for the first http(s) link in the text.
  useEffect(() => {
    if (link || photos.length || video) return;
    const found = firstUrl(text);
    const u = found ? normalizeUrl(found.url) : null;
    if (req.current && req.current.url !== u) { req.current.ac.abort(); req.current = null; setLinkLoading(false); }
    if (!found || !u || skip.current.has(u) || req.current) return;
    const delay = pasted.current ? 50 : found.complete ? 400 : 1200;
    pasted.current = false;
    const timer = setTimeout(() => {
      const ac = new AbortController();
      setLinkLoading(true);
      const p = loadLinkDraft(u, ac.signal).then((d) => {
        if (req.current?.url === u) { req.current = null; setLinkLoading(false); setLink(d); }
        return d;
      }).catch(() => {
        skip.current.add(u);
        if (req.current?.url === u) { req.current = null; setLinkLoading(false); }
        return null;
      });
      req.current = { url: u, ac, p };
    }, delay);
    return () => clearTimeout(timer);
  }, [text, link, photos.length, video]);

  useEffect(() => () => req.current?.ac.abort(), []);

  const linkBlob = link?.image?.blob;
  const linkImg = useMemo(() => (linkBlob ? URL.createObjectURL(linkBlob) : null), [linkBlob]);
  useEffect(() => () => { if (linkImg) URL.revokeObjectURL(linkImg); }, [linkImg]);

  const photoUrls = useRef(new Set<string>());
  useEffect(() => {
    const urls = photoUrls.current;
    return () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls.clear(); };
  }, []);
  const dropPhoto = (p: Picked) => { URL.revokeObjectURL(p.url); photoUrls.current.delete(p.url); setPhotos((xs) => xs.filter((x) => x.id !== p.id)); };
  const clearPhotos = () => { photos.forEach((p) => { URL.revokeObjectURL(p.url); photoUrls.current.delete(p.url); }); setPhotos([]); };

  function removeLink() {
    if (link) skip.current.add(link.preview.url);
    setLink(null);
  }

  function addPhotos(list: FileList | null) {
    setErr(null);
    if (!list) return;
    const files = [...list].filter((x) => x.type.startsWith('image/'));
    if (files.some((x) => x.size > MAX_PHOTO_BYTES)) { setErr(t('feed.photoTooBig')); return; }
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) setErr(t('feed.tooManyPhotos', { count: MAX_PHOTOS }));
    const added = files.slice(0, room).map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    added.forEach((p) => photoUrls.current.add(p.url));
    setPhotos((prev) => [...prev, ...added]);
    setLink(null);
    if (photoInput.current) photoInput.current.value = '';
  }

  async function pickVideo(file: File | undefined) {
    setErr(null);
    if (videoInput.current) videoInput.current.value = '';
    if (!file) return;
    if (!videoMime(file) || file.size === 0) { setErr(t('feed.videoType')); return; }
    if (file.size > MAX_VIDEO_BYTES) { setErr(t('feed.videoTooBig', { size: formatBytes(MAX_VIDEO_BYTES, f.number) })); return; }
    setVideo({ file, probe: null, poster: null });
    setLink(null);
    const probe = await probeVideo(file);
    const poster = probe.poster ? URL.createObjectURL(probe.poster.blob) : null;
    setVideo((v) => (v && v.file === file ? { file, probe, poster } : v));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !userId) return;
    setErr(null);
    const body = text.trim().slice(0, MAX_TEXT);
    const pendingLink = req.current;
    if (!body && !photos.length && !video && !link && !pendingLink) { setErr(t('feed.writeSomething')); return; }
    const schedule = options.schedule;
    if (schedule) {
      const problem = checkSchedule(schedule);
      if (problem) { setErr(t(scheduleProblemKey(problem))); setOptionsOpen(true); return; }
    }
    setBusy(true);
    const id = crypto.randomUUID();
    const uploaded: string[] = [];
    try {
      const target = await resolve(audience);
      const payload: PostPayload = {};
      let kind: PostKind = 'status';
      if (body) payload.text = body;
      if (photos.length) {
        kind = 'photo';
        payload.photos = [];
        for (let i = 0; i < photos.length; i++) {
          setProgress({ label: t('feed.uploadingPhotos', { n: i + 1, total: photos.length }), pct: Math.round((i / photos.length) * 100) });
          const files = await uploadPhoto(photos[i]!.file);
          uploaded.push(...photoPaths(files));
          payload.photos.push({ id: crypto.randomUUID(), albumId: '', files });
        }
      } else if (video) {
        kind = 'video';
        setProgress({ label: t('feed.encrypting') });
        const r = await uploadVideo(video.file, video.probe, (sent, total) => {
          const pct = Math.min(100, Math.floor((sent / total) * 100));
          setProgress({ label: t('feed.uploading', { pct }), pct });
        });
        uploaded.push(...r.paths);
        payload.video = r.video;
      } else {
        // A preview still loading is awaited briefly, so the link isn't posted bare — but never for long.
        const d = link ?? (pendingLink ? await Promise.race([pendingLink.p, new Promise<null>((r) => setTimeout(() => r(null), 8000))]) : null);
        if (pendingLink && !link) { pendingLink.ac.abort(); req.current = null; setLinkLoading(false); }
        if (d) {
          kind = 'link';
          const image = d.image ? await uploadPreparedImage(d.image).catch(() => undefined) : undefined;
          if (image) uploaded.push(image.path);
          payload.link = toPayloadLink(d.preview, image, d.embed);
        }
      }
      setProgress({ label: t('feed.sharing'), pct: 100 });
      await createPost({
        id, kind, payload: clean(payload), audience: target.audience, groupId: target.groupId, eventId: target.eventId,
        publishAt: schedule ? schedule.toISOString() : null, disappearSecs: options.disappear,
      });
      if (uploaded.length) await linkPostMedia(uploaded, id);
      setText(''); clearPhotos(); setVideo(null); setLink(null); skip.current.clear();
      setOptions({ disappear: null, schedule: null });
      if (schedule) {
        toast({ message: t('schedule.done', { when: when(schedule) }), action: { label: t('schedule.view'), onClick: () => router.push('/you/scheduled') } });
        void qc.invalidateQueries({ queryKey: ['scheduled'] });
      } else toast({ message: t('feed.posted') });
      await qc.invalidateQueries({ queryKey: ['v2feed'] });
      onPosted?.();
    } catch (x) {
      if (uploaded.length) await deleteMedia(uploaded).catch(() => undefined);
      setErr(x instanceof KeyWaitingError ? t('feed.keyWaiting') : t('feed.failed'));
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  const audienceLabel = audience.kind === 'connections' ? t('feed.toConnections')
    : audience.kind === 'only_me' ? t('feed.toOnlyMe')
    : audience.kind === 'circle' ? (circles.find((c) => c.id === audience.circleId)?.name ?? t('feed.audienceCircle'))
    : t('feed.audienceEvent');
  const audienceIcon = audience.kind === 'only_me' ? 'lock' : audience.kind === 'circle' ? 'circles' : audience.kind === 'event' ? 'calendar' : 'users';
  const canPost = !busy && (!!text.trim() || photos.length > 0 || !!video || !!link);

  return (
    <Card className="k-composer">
      <form onSubmit={(e) => void submit(e)} aria-label={t('feed.composerLabel')}>
        <div className="k-composer-top">
          <Avatar name={me.name} src={me.avatar} size={40} />
          <label htmlFor={textId} className="k-sr-only">{placeholder ?? t('feed.composerPlaceholder')}</label>
          <textarea id={textId} className="k-composer-text" dir="auto" rows={text ? 3 : 2} maxLength={MAX_TEXT} value={text} disabled={busy}
            placeholder={placeholder ?? t('feed.composerPlaceholder')}
            onPaste={() => { pasted.current = true; }} onChange={(e) => setText(e.target.value)} />
        </div>

        {photos.length ? (
          <ul className="k-composer-photos" role="list">
            {photos.map((p, i) => (
              <li key={p.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt="" />
                <IconButton icon="close" size="sm" variant="soft" label={t('feed.removePhoto', { n: i + 1 })} disabled={busy}
                  onClick={() => dropPhoto(p)} />
              </li>
            ))}
          </ul>
        ) : null}

        {video ? (
          <div className="k-composer-video">
            <span className="k-composer-video-th">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {video.poster ? <img src={video.poster} alt="" /> : <Icon name="video" />}
            </span>
            <span className="k-composer-video-info">
              <span className="k-lc-title">{video.file.name}</span>
              <span className="k-muted k-small">
                {video.probe ? t('feed.videoInfo', { size: [formatDuration(video.probe.duration), formatBytes(video.file.size, f.number)].filter(Boolean).join(' · ') }) : t('feed.videoReading')}
              </span>
            </span>
            <IconButton icon="close" size="sm" variant="soft" label={t('feed.removeVideo')} disabled={busy} onClick={() => setVideo(null)} />
          </div>
        ) : null}

        {linkLoading && !link ? <p className="k-muted k-small" role="status">{t('feed.loadingPreview')}</p> : null}
        {link ? (
          <div className="k-stack-sm">
            <LinkCard link={toPayloadLink(link.preview, undefined, link.embed)} onRemove={busy ? undefined : removeLink}
              localImg={link.image && linkImg ? { url: linkImg, w: link.image.w, h: link.image.h } : null} />
            <p className="k-muted k-xs">{t('feed.previewNote')}</p>
          </div>
        ) : null}

        {progress ? (
          <div className="k-composer-progress" role="status" aria-live="polite">
            <span className="k-small">{progress.label}</span>
            <span className="k-progress" aria-hidden><span style={{ inlineSize: `${progress.pct ?? 5}%` }} data-indeterminate={progress.pct === undefined ? '' : undefined} /></span>
          </div>
        ) : null}
        <PostOptionChips value={options} disabled={busy} onChange={setOptions} onOpen={() => setOptionsOpen(true)} />
        {err ? <p className="k-error" role="alert"><Icon name="alert" />{err}</p> : null}

        <div className="k-composer-bar">
          <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
          <input ref={videoInput} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={(e) => void pickVideo(e.target.files?.[0])} />
          <IconButton icon="image" label={t('feed.addPhotos')} disabled={busy || !!video || photos.length >= MAX_PHOTOS} onClick={() => photoInput.current?.click()} />
          <IconButton icon="video" label={t('feed.addVideo')} disabled={busy || photos.length > 0 || !!video} onClick={() => videoInput.current?.click()} />
          <IconButton icon="clock" label={t('schedule.options')} disabled={busy} aria-haspopup="dialog"
            variant={options.disappear || options.schedule ? 'soft' : 'ghost'} onClick={() => setOptionsOpen(true)} />
          <span className="k-spacer" />
          {fixedAudience ? (
            <span className="k-chip" title={t('feed.sharedWith', { audience: audienceLabel })}><Icon name={audienceIcon} />{audienceLabel}</span>
          ) : (
            <button type="button" className="k-chip k-chip-btn" aria-haspopup="dialog" onClick={() => setPicking(true)} disabled={busy}
              aria-label={`${t('feed.audiencePicker')} ${audienceLabel}`}>
              <Icon name={audienceIcon} /><span>{audienceLabel}</span><Icon name="down" />
            </button>
          )}
          <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!canPost}>{options.schedule ? t('schedule.submit') : t('feed.post')}</Button>
        </div>
      </form>

      <PostOptionsDialog open={optionsOpen} value={options} onClose={() => setOptionsOpen(false)} onChange={(v) => { setOptions(v); setErr(null); }} />
      {!fixedAudience ? (
        <Dialog open={picking} onClose={() => setPicking(false)} title={t('feed.audiencePicker')} sheet>
          <AudienceOptions value={audience} circles={circles} onPick={(a) => { setAudience(a); setPicking(false); }} />
        </Dialog>
      ) : null}
    </Card>
  );
}

export function AudienceOptions({ value, circles, onPick, allowOnlyMe = true }: {
  value: ComposerAudience | { kind: 'connections' } | { kind: 'circle'; circleId: string };
  circles: { id: string; name: string }[];
  onPick: (a: ComposerAudience) => void;
  allowOnlyMe?: boolean;
}) {
  const t = useT();
  const opt = (a: ComposerAudience, icon: 'users' | 'lock' | 'circles', title: string, sub: string) => {
    const on = a.kind === value.kind && (a.kind !== 'circle' || (value.kind === 'circle' && value.circleId === a.circleId));
    return (
      <li key={a.kind === 'circle' ? a.circleId : a.kind}>
        <button type="button" className="k-item k-aud-opt" aria-pressed={on} onClick={() => onPick(a)}>
          <span className="k-item-lead k-item-icon"><Icon name={icon} /></span>
          <span className="k-item-body"><span className="k-item-title">{title}</span><span className="k-item-sub">{sub}</span></span>
          <span className="k-item-trail">{on ? <Icon name="check" /> : null}</span>
        </button>
      </li>
    );
  };
  return (
    <div className="k-stack">
      <ul className="k-list" role="list">
        {opt({ kind: 'connections' }, 'users', t('feed.toConnections'), t('feed.toConnectionsSub'))}
        {allowOnlyMe ? opt({ kind: 'only_me' }, 'lock', t('feed.toOnlyMe'), t('feed.toOnlyMeSub')) : null}
      </ul>
      <h3 className="k-section-title">{t('feed.circlesHeading')}</h3>
      {circles.length ? (
        <ul className="k-list" role="list">
          {circles.map((c) => opt({ kind: 'circle', circleId: c.id }, 'circles', c.name, t('feed.toCircleSub')))}
        </ul>
      ) : <p className="k-muted k-small">{t('feed.noCircles')}</p>}
    </div>
  );
}
