'use client';
// Stories (24 h) at the top of Home: a row of rings (yours first, then unseen, then seen), a full-screen
// viewer (tap / hold / swipe, progress bars, keyboard), and a composer for a photo or text story shared
// with your connections or one circle. Views are recorded privately: only the author sees who viewed.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useLocale, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { AudienceOptions, useMyCircles } from '@/components/posts/Composer';
import { RelativeTime, RichText } from '@/components/posts/bits';
import type { ComposerAudience } from '@/components/posts';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { KeyWaitingError } from '@/lib/keys/keyring';
import { useFileUrl } from '@/lib/media';
import { usePeopleVersion, usePerson } from '@/lib/people';
import {
  createStory, deleteStory, listStories, markStoryViewed, readStory, seenStoryIds, storyViewers,
  STORY_BACKGROUNDS, STORY_MAX_TEXT, type StoryAudience, type StoryRow,
} from '@/lib/stories';
import { buildRings, hoursLeft, startIndex, step, type Ring } from './logic';

const STORY_MS = 6000;

function useStories() {
  const { status } = useSession();
  return useQuery({
    queryKey: ['stories'], enabled: status === 'ready', refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const [rows, seen] = await Promise.all([listStories(), seenStoryIds()]);
      return { rows, seen };
    },
  });
}

export function StoriesRow() {
  const t = useT();
  const { userId } = useSession();
  const q = useStories();
  const [open, setOpen] = useState<{ ring: number; story: number } | null>(null);
  const [composing, setComposing] = useState(false);
  // Rings are frozen while the viewer is open so newly-seen stories don't reorder under the viewer.
  const [frozen, setFrozen] = useState<Ring<StoryRow>[] | null>(null);
  const live = useMemo(() => (q.data && userId ? buildRings(q.data.rows, userId, q.data.seen) : []), [q.data, userId]);
  const rings = frozen ?? live;
  const mine = live[0]?.authorId === userId ? live[0] : null;

  function openRing(i: number) {
    setFrozen(live);
    setOpen({ ring: i, story: startIndex(live[i]!, q.data?.seen ?? new Set()) });
  }

  return (
    <section className="k-stories" aria-label={t('stories.row')}>
      <ul className="k-stories-list" role="list">
        <li className="k-story-ring-item">
          {mine ? (
            <div className="k-story-mine">
              <RingButton ring={mine} self onOpen={() => openRing(0)} />
              <button type="button" className="k-story-addbadge" aria-label={t('stories.add')} title={t('stories.add')} onClick={() => setComposing(true)}>
                <Icon name="plus" />
              </button>
            </div>
          ) : (
            <button type="button" className="k-story-ring k-story-add" onClick={() => setComposing(true)}>
              <span className="k-story-ring-art" aria-hidden><Icon name="plus" /></span>
              <span className="k-story-ring-name">{t('stories.add')}</span>
            </button>
          )}
        </li>
        {q.isPending ? [0, 1, 2].map((i) => <li key={i} className="k-story-ring-item" aria-hidden><span className="k-story-ring-art k-skel" /></li>) : null}
        {live.map((r, i) => (r.authorId === userId ? null : (
          <li key={r.authorId} className="k-story-ring-item"><RingButton ring={r} onOpen={() => openRing(i)} /></li>
        )))}
      </ul>
      {open && rings.length ? (
        <StoryViewer rings={rings} start={open} seen={q.data?.seen ?? new Set()}
          onClose={() => { setOpen(null); setFrozen(null); void q.refetch(); }} />
      ) : null}
      <StoryComposer open={composing} onClose={() => setComposing(false)} />
    </section>
  );
}

function RingButton({ ring, self, onOpen }: { ring: Ring<StoryRow>; self?: boolean; onOpen: () => void }) {
  const t = useT();
  const p = usePerson(ring.authorId);
  const avatar = useFileUrl(p?.info?.avatar?.thumb);
  const name = self ? t('stories.yours') : p?.name ?? '…';
  return (
    <button type="button" className="k-story-ring" data-unseen={ring.unseen ? '' : undefined} onClick={onOpen}
      aria-label={ring.unseen ? t('stories.openNew', { name }) : t('stories.open', { name })}>
      <span className="k-story-ring-art" aria-hidden><Avatar name={p?.name ?? ''} src={avatar} size={56} /></span>
      <span className="k-story-ring-name" aria-hidden>{name}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Viewer

function StoryViewer({ rings, start, seen, onClose }: {
  rings: Ring<StoryRow>[]; start: { ring: number; story: number }; seen: ReadonlySet<string>; onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { dir } = useLocale();
  const { userId } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  const ref = useRef<HTMLDialogElement>(null);
  const [pos, setPos] = useState(start);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [viewers, setViewers] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const press = useRef<{ x: number; y: number; t: number } | null>(null);
  const spent = useRef(0);
  const ring = rings[pos.ring]!;
  const story = ring.stories[pos.story]!;
  const author = usePerson(ring.authorId);
  const avatar = useFileUrl(author?.info?.avatar?.thumb);
  const d = readStory(story);
  const photo = useFileUrl(d.ok ? d.value.photo?.file : null);
  const mine = story.author_id === userId;
  const ready = d.ok && (!d.value.photo || !!photo);
  const stopped = paused || held || viewers || confirmDelete || !ready;

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    document.documentElement.style.overflow = 'hidden';
    return () => { document.documentElement.style.overflow = ''; };
  }, []);

  // Record the view (private to the author) once the story is actually shown.
  useEffect(() => {
    if (!ready || mine || seen.has(story.id)) return;
    markStoryViewed(story).catch(() => undefined);
  }, [ready, mine, story, seen]);

  function go(dirn: 1 | -1) {
    const next = step(rings, pos, dirn);
    if (next === 'close') { onClose(); return; }
    setPos(next); setElapsed(0); spent.current = 0;
  }
  const goRef = useRef(go);
  useEffect(() => { goRef.current = go; });

  // Timer: advance after STORY_MS of visible, unpaused time (held / paused / hidden tab stop it).
  useEffect(() => {
    if (stopped) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      if (document.visibilityState === 'visible') spent.current += now - last;
      last = now;
      setElapsed(spent.current);
      if (spent.current >= STORY_MS) { goRef.current(1); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stopped, pos]);

  const fwd = dir === 'rtl' ? -1 : 1;
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(fwd === 1 ? 1 : -1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(fwd === 1 ? -1 : 1); }
    else if (e.key === ' ' && e.target === e.currentTarget) { e.preventDefault(); setPaused((p) => !p); }
  }
  function down(e: RPointerEvent) {
    press.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    setHeld(true);
  }
  function up(e: RPointerEvent) {
    setHeld(false);
    const p = press.current;
    press.current = null;
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      // Swipe to the next / previous person.
      const target = (dx < 0) === (fwd === 1) ? pos.ring + 1 : pos.ring - 1;
      if (target >= rings.length) { onClose(); return; }
      if (target >= 0) { setPos({ ring: target, story: 0 }); setElapsed(0); spent.current = 0; }
      return;
    }
    if (Date.now() - p.t > 350) return; // a hold just pauses
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const startSide = dir === 'rtl' ? x > rect.width * 0.67 : x < rect.width * 0.33;
    go(startSide ? -1 : 1);
  }

  async function remove() {
    try {
      await deleteStory(story, d.ok ? d.value : null);
      toast({ message: t('stories.deleted') });
      await qc.invalidateQueries({ queryKey: ['stories'] });
      onClose();
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }

  const pct = Math.min(100, (elapsed / STORY_MS) * 100);
  const bg = d.ok && !d.value.photo ? (d.value.bg ?? 0) % STORY_BACKGROUNDS : null;
  return (
    <dialog ref={ref} className="k-storyview" aria-label={t('stories.viewer')} onKeyDown={onKey}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="k-storyview-card" data-bg={bg ?? undefined}>
        <div className="k-storyview-bars" role="progressbar" aria-label={t('stories.progress', { n: pos.story + 1, total: ring.stories.length })}
          aria-valuemin={0} aria-valuemax={ring.stories.length} aria-valuenow={pos.story + 1}>
          {ring.stories.map((s, i) => (
            <span key={s.id} className="k-storyview-bar"><span style={{ inlineSize: `${i < pos.story ? 100 : i === pos.story ? pct : 0}%` }} /></span>
          ))}
        </div>
        <header className="k-storyview-head">
          <Avatar name={author?.name ?? ''} src={avatar} size={36} />
          <span className="k-storyview-who">
            <span className="k-storyview-name">{mine ? t('stories.yours') : author?.name ?? '…'}</span>
            <span className="k-storyview-time"><RelativeTime iso={story.created_at} /> · {t('stories.hoursLeft', { count: hoursLeft(story.expires_at) })}</span>
          </span>
          <IconButton icon={paused ? 'play' : 'pause'} size="sm" label={paused ? t('stories.play') : t('stories.pause')} onClick={() => setPaused(!paused)} />
          <IconButton icon="close" size="sm" label={t('common.close')} onClick={onClose} />
        </header>
        <div className="k-storyview-stage" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { setHeld(false); press.current = null; }}
          onContextMenu={(e) => e.preventDefault()}>
          {!d.ok ? (
            <p className="k-storyview-msg">{d.reason === 'waiting' ? t('stories.waiting') : t('stories.unverified')}</p>
          ) : d.value.photo ? (
            photo
              // eslint-disable-next-line @next/next/no-img-element
              ? <img className="k-storyview-img" src={photo} alt={d.value.text ?? ''} draggable={false} />
              : <Spinner size={32} />
          ) : null}
          {d.ok && d.value.text ? (
            <div className={d.value.photo ? 'k-storyview-caption' : 'k-storyview-text'}><RichText text={d.value.text} clamp={STORY_MAX_TEXT} /></div>
          ) : null}
        </div>
        <div className="k-storyview-nav">
          <IconButton icon="back" size="sm" variant="soft" label={t('stories.prev')} onClick={() => go(-1)} />
          {mine ? (
            <>
              <Button size="sm" variant="soft" icon="eye" onClick={() => setViewers(true)}>{t('stories.viewersTitle')}</Button>
              <IconButton icon="trash" size="sm" variant="soft" label={t('stories.delete')} onClick={() => setConfirmDelete(true)} />
            </>
          ) : <span className="k-spacer" />}
          <IconButton icon="forward" size="sm" variant="soft" label={t('stories.next')} onClick={() => go(1)} />
        </div>
      </div>
      {mine ? <ViewersSheet storyId={story.id} open={viewers} onClose={() => setViewers(false)} /> : null}
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={t('stories.delete')}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('feed.cancel')}</Button>
          <Button variant="danger" onClick={() => void remove()}>{t('feed.delete')}</Button>
        </>} />
    </dialog>
  );
}

function ViewersSheet({ storyId, open, onClose }: { storyId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['story-viewers', storyId], enabled: open, queryFn: () => storyViewers(storyId) });
  const n = q.data?.length ?? 0;
  return (
    <Dialog open={open} onClose={onClose} title={t('stories.seenBy', { count: n })} sheet>
      <div className="k-stack">
        <p className="k-muted k-small"><Icon name="lock" /> {t('stories.viewersPrivate')}</p>
        {q.isPending ? <Spinner /> : (
          <ul className="k-list" role="list">
            {q.data?.map((v) => <li key={v.viewer_id}><ViewerRow id={v.viewer_id} at={v.viewed_at} /></li>)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ViewerRow({ id, at }: { id: string; at: string }) {
  const p = usePerson(id);
  const avatar = useFileUrl(p?.info?.avatar?.thumb);
  return (
    <div className="k-item">
      <span className="k-item-lead"><Avatar name={p?.name ?? ''} src={avatar} size={36} /></span>
      <span className="k-item-body"><span className="k-item-title">{p?.name ?? '…'}</span><span className="k-item-sub"><RelativeTime iso={at} /></span></span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Composer

export function StoryComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const circles = useMyCircles(open);
  const [mode, setMode] = useState<'text' | 'photo'>('text');
  const [text, setText] = useState('');
  const [bg, setBg] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [audience, setAudience] = useState<StoryAudience>({ kind: 'connections' });
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function reset() { setText(''); setFile(null); setBg(0); setErr(null); setMode('text'); }

  async function share() {
    setErr(null);
    if (mode === 'text' && !text.trim()) { setErr(t('feed.writeSomething')); return; }
    if (mode === 'photo' && !file) { setErr(t('stories.choosePhoto')); return; }
    setBusy(true);
    try {
      await createStory({ audience, text, ...(mode === 'text' ? { bg } : { photo: file! }) });
      toast({ message: t('stories.shared') });
      await qc.invalidateQueries({ queryKey: ['stories'] });
      reset();
      onClose();
    } catch (e) {
      setErr(e instanceof KeyWaitingError ? t('feed.keyWaiting') : t('feed.failed'));
    } finally { setBusy(false); }
  }

  const audienceLabel = audience.kind === 'connections' ? t('feed.toConnections')
    : circles.find((c) => c.id === audience.circleId)?.name ?? t('feed.audienceCircle');
  return (
    <Dialog open={open} onClose={onClose} title={t('stories.newTitle')} sheet dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('feed.cancel')}</Button>
        <Button variant="primary" onClick={() => void share()} busy={busy}>{t('stories.share')}</Button>
      </>}>
      <div className="k-stack">
        <Segmented label={t('stories.newTitle')} value={mode} onChange={setMode} block
          options={[{ value: 'text', label: t('stories.text'), icon: 'edit' }, { value: 'photo', label: t('stories.photo'), icon: 'image' }]} />
        {mode === 'text' ? (
          <>
            <div className="k-story-draft" data-bg={bg}>
              <textarea aria-label={t('stories.textPlaceholder')} placeholder={t('stories.textPlaceholder')} dir="auto" value={text}
                maxLength={STORY_MAX_TEXT} rows={4} onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="k-story-swatches" role="radiogroup" aria-label={t('stories.backgroundGroup')}>
              {Array.from({ length: STORY_BACKGROUNDS }, (_, i) => (
                <button key={i} type="button" role="radio" aria-checked={bg === i} className="k-story-swatch" data-bg={i}
                  aria-label={t('stories.background', { n: i + 1 })} onClick={() => setBg(i)} />
              ))}
            </div>
          </>
        ) : (
          <>
            <input ref={input} type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {preview ? (
              <div className="k-story-draft k-story-draft-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview} alt="" />
              </div>
            ) : null}
            <Button variant="soft" icon="image" onClick={() => input.current?.click()}>{preview ? t('stories.changePhoto') : t('stories.choosePhoto')}</Button>
            <textarea className="k-story-captionfield" aria-label={t('stories.caption')} placeholder={t('stories.caption')} dir="auto" value={text}
              maxLength={STORY_MAX_TEXT} rows={2} onChange={(e) => setText(e.target.value)} />
          </>
        )}
        <div className="k-row">
          <span className="k-label">{t('stories.audience')}</span>
          <button type="button" className="k-chip k-chip-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}>
            <Icon name={audience.kind === 'circle' ? 'circles' : 'users'} /><span>{audienceLabel}</span><Icon name="down" />
          </button>
        </div>
        <p className="k-muted k-small"><Icon name="clock" /> {t('stories.expiryNote')}</p>
        {err ? <p className="k-error" role="alert"><Icon name="alert" />{err}</p> : null}
      </div>
      <Dialog open={picking} onClose={() => setPicking(false)} title={t('stories.audience')} sheet>
        <AudienceOptions value={audience} circles={circles} allowOnlyMe={false}
          onPick={(a: ComposerAudience) => { if (a.kind === 'connections' || a.kind === 'circle') setAudience(a); setPicking(false); }} />
      </Dialog>
    </Dialog>
  );
}
