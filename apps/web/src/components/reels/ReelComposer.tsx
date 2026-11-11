'use client';
// Making a reel (docs/v2/12-reels.md §2): pick a video or record one here, trim it to at most a minute, choose
// the cover, write a caption, choose who sees it, and share. Before anything is uploaded the video is
// re-encoded on this device to at most 720p (lib/reels/transcode), which also drops what the camera wrote
// into the file; then it is encrypted and uploaded like any post video (lib/reels/data publishReel), with a
// progress bar and a cancel button. Public and Followers are offered only to accounts that let people follow
// them, exactly as in the post composer, and Public is explained before the first public post.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFormat, useLocale, useT, type MessageKey } from '@/i18n';
import { Button, IconButton } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import type { ComposerAudience } from '@/components/posts';
import { formatBytes, formatDuration } from '@/components/posts/bits';
import { AudienceOptions, resolve, useMyCircles } from '@/components/posts/Composer';
import { videoMime } from '@/components/posts/video';
import type { PreparedImage } from '@/lib/feed/linkPreview';
import { useAppNumber, useAppSetting, useKeyringReady } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { onMobileData, useDataSaver } from '@/lib/net/dataSaver';
import { publishReel, ReelPublishError, type ReelPublishProblem } from '@/lib/reels/data';
import {
  clampTrim, estimateBytes, initialTrim, maxVideoBytes, originalVerdict, planEncode, REEL_CAPTION_MAX, REEL_DEFAULT_MAX_MB, REEL_MAX_SECONDS,
  REEL_SOURCE_MAX_BYTES, type OriginalVerdict,
} from '@/lib/reels/plan';
import { encodeReel, encodeSupport, grabCover, isAbort, probeSource, recorderType, type SourceInfo } from '@/lib/reels/transcode';
import { markPublicExplained, publicExplained, useHiddenStore } from '@/lib/social/hiddenStore';
import type { PostRow } from '@/lib/types';
import '@/styles/v2/reels.css';

interface Source { file: Blob; url: string; info: SourceInfo; mime: string | null }
type Work = { phase: 'encode' | 'encrypt' | 'upload' | 'share'; pct?: number };

const PROBLEM: Record<ReelPublishProblem, MessageKey> = {
  limit: 'reels.make.errLimit', too_big: 'reels.make.errTooBig', off: 'reels.offBody', offline: 'reels.make.errOffline',
  key: 'feed.keyWaiting', failed: 'feed.failed',
};
const ORIGINAL: Record<Exclude<OriginalVerdict, 'ok'>, MessageKey> = {
  too_long: 'reels.make.origTooLong', too_big: 'reels.make.origTooBig', trimmed: 'reels.make.origTrimmed', type: 'reels.make.origType',
};

export function ReelComposer({ open, onClose, audience: initial, fixedAudience, onPosted }: {
  open: boolean;
  onClose: () => void;
  /** Pre-selected audience (the post composer passes its own; inside a circle it is fixed). */
  audience: ComposerAudience;
  fixedAudience?: boolean;
  onPosted?: (row: PostRow) => void;
}) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const { locale } = useLocale();
  const { profile } = useSession();
  const saver = useDataSaver();
  const keysReady = useKeyringReady();
  const hiddenStore = useHiddenStore();
  const circles = useMyCircles(!fixedAudience);
  const maxMb = useAppNumber('reel_max_mb', REEL_DEFAULT_MAX_MB);
  const maxBytes = maxVideoBytes(maxMb);
  // Followers and Public as in the post composer: only with follow on; Public also needs the operator's
  // switch and an account past the waiting period (the database enforces all of it).
  const followOn = !!profile?.follow_enabled;
  const publicOn = useAppSetting('public_posts_enabled').data === true;
  const minAgeHours = useAppNumber('public_post_min_age_hours', 24);
  const [mountedAt] = useState(() => Date.now());
  const tooNew = !!profile?.created_at && mountedAt - Date.parse(profile.created_at) < minAgeHours * 3_600_000;

  const [step, setStep] = useState<'pick' | 'record' | 'edit' | 'work'>('pick');
  const [src, setSrc] = useState<Source | null>(null);
  const [reading, setReading] = useState(false);
  const [trim, setTrim] = useState({ start: 0, end: 0 });
  const [coverAt, setCoverAt] = useState(0);
  const [cover, setCover] = useState<PreparedImage | null>(null);
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<ComposerAudience>(initial.kind === 'event' ? { kind: 'connections' } : initial);
  const [picking, setPicking] = useState(false);
  const [intro, setIntro] = useState(false);
  const [work, setWork] = useState<Work | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const workSlot = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const ids = useId();

  const support = useMemo(() => encodeSupport(), []);
  const canEncode = support.webcodecs || support.recorder;
  const plan = useMemo(() => planEncode(src?.info.w ?? 0, src?.info.h ?? 0, saver), [src, saver]);
  const length = Math.max(0, trim.end - trim.start);
  const estimate = canEncode ? estimateBytes(length, plan) : src?.file.size ?? 0;
  const verdict: OriginalVerdict | null = src && !canEncode ? originalVerdict({ size: src.file.size, mime: src.mime }, src.info.duration, trim, maxBytes) : null;
  const coverUrl = useMemo(() => (cover ? URL.createObjectURL(cover.blob) : null), [cover]);
  useEffect(() => () => { if (coverUrl) URL.revokeObjectURL(coverUrl); }, [coverUrl]);
  const srcUrl = src?.url;
  useEffect(() => () => { if (srcUrl) URL.revokeObjectURL(srcUrl); }, [srcUrl]);
  useEffect(() => () => abort.current?.abort(), []);

  async function choose(file: Blob | undefined) {
    setErr(null);
    if (fileInput.current) fileInput.current.value = '';
    if (cameraInput.current) cameraInput.current.value = '';
    if (!file) return;
    const mime = file instanceof File ? videoMime(file) : /^video\/(mp4|webm)/.test(file.type) ? file.type.split(';')[0]! : null;
    if (!file.size || !(mime || file.type.startsWith('video/'))) { setErr(t('feed.videoType')); return; }
    if (file.size > REEL_SOURCE_MAX_BYTES) { setErr(t('reels.make.sourceTooBig')); return; }
    setReading(true);
    const info = await probeSource(file);
    setReading(false);
    if (!info) { setErr(t('reels.make.cantPlay')); setStep('pick'); return; }
    const first = initialTrim(info.duration);
    setSrc({ file, url: URL.createObjectURL(file), info, mime });
    setTrim(first);
    setCoverAt(first.start);
    setCover(null);
    setStep('edit');
  }

  // The cover: the frame at `coverAt`, grabbed from the preview a moment after the slider stops moving.
  useEffect(() => {
    if (step !== 'edit' || !src) return;
    const v = preview.current;
    if (!v) return;
    let live = true;
    const timer = setTimeout(() => {
      const grab = () => { void grabCover(v).then((c) => { if (live && c) setCover(c); }); };
      v.pause();
      const target = Math.min(Math.max(coverAt, 0), Math.max(0, src.info.duration - 0.05));
      if (Math.abs(v.currentTime - target) < 0.04 && v.readyState >= 2) { grab(); return; }
      v.addEventListener('seeked', grab, { once: true });
      v.currentTime = target;
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [coverAt, src, step]);

  function moveTrim(edge: 'start' | 'end', value: number) {
    if (!src) return;
    const next = clampTrim(edge === 'start' ? value : trim.start, edge === 'end' ? value : trim.end, src.info.duration, edge);
    setTrim(next);
    if (coverAt < next.start || coverAt > next.end) setCoverAt(next.start);
    const v = preview.current;
    if (v) { v.pause(); v.currentTime = edge === 'start' ? next.start : Math.max(next.start, next.end - 0.6); }
  }

  function togglePreview() {
    const v = preview.current;
    if (!v) return;
    if (!v.paused) { v.pause(); return; }
    if (v.currentTime < trim.start || v.currentTime >= trim.end - 0.05) v.currentTime = trim.start;
    void v.play().catch(() => undefined);
  }

  /** `explained`: the "Public means anyone" explanation was just confirmed. */
  async function share(explained = false) {
    if (!src || work) return;
    setErr(null);
    if (audience.kind === 'public' && !explained && !hiddenStore.publicExplained) {
      const seen = await publicExplained().catch(() => false);
      if (!seen) { setIntro(true); return; }
    }
    preview.current?.pause();
    const ac = new AbortController();
    abort.current = ac;
    setStep('work');
    setWork({ phase: 'encode', pct: 0 });
    try {
      const target = await resolve(audience);
      let video: { blob: Blob; mime: string; w: number; h: number; duration: number } | null = null;
      if (canEncode) {
        const onProgress = (x: number) => setWork({ phase: 'encode', pct: Math.round(x * 100) });
        try {
          let enc = await encodeReel({ file: src.file, start: trim.start, end: trim.end, target: plan, signal: ac.signal, mount: workSlot.current, onProgress });
          if (enc.blob.size > maxBytes) {
            // Busier pictures than the bitrate allowed for: once more, smaller.
            const videoBps = Math.max(150_000, Math.round(plan.videoBps * (maxBytes / enc.blob.size) * 0.8));
            enc = await encodeReel({ file: src.file, start: trim.start, end: trim.end, target: { ...plan, videoBps }, signal: ac.signal, mount: workSlot.current, onProgress },
              enc.method === 'recorder' ? 'recorder' : 'webcodecs');
          }
          if (enc.blob.size > maxBytes) throw new ReelPublishError('too_big');
          video = enc;
        } catch (e) {
          if (isAbort(e) || e instanceof ReelPublishError) throw e;
          // The device could not do it after all: fall through to the original, if that is allowed.
        }
      }
      if (!video) {
        const v = originalVerdict({ size: src.file.size, mime: src.mime }, src.info.duration, trim, maxBytes);
        if (v !== 'ok') { setErr(`${t('reels.make.cantShrink')} ${t(ORIGINAL[v], { size: formatBytes(maxBytes, f.number) })}`); setStep('edit'); return; }
        video = { blob: src.file, mime: src.mime!, w: src.info.w, h: src.info.h, duration: src.info.duration };
      }
      const row = await publishReel({ video, cover, caption, audience: target.audience, groupId: target.groupId, lang: locale }, {
        signal: ac.signal,
        onPhase: (phase) => setWork((w) => (w?.phase === phase ? w : { phase, pct: phase === 'upload' ? 0 : undefined })),
        onProgress: (sent, total) => setWork({ phase: 'upload', pct: Math.min(100, Math.floor((sent / total) * 100)) }),
      });
      toast({ message: t('reels.make.done') });
      void qc.invalidateQueries({ queryKey: ['v2feed'] });
      void qc.invalidateQueries({ queryKey: ['public-posts'] });
      void qc.invalidateQueries({ queryKey: ['reels'] });
      onPosted?.(row);
      onClose();
    } catch (e) {
      if (!isAbort(e)) setErr(t(PROBLEM[e instanceof ReelPublishError ? e.problem : 'failed'], { size: formatBytes(maxBytes, f.number) }));
      setStep('edit');
    } finally {
      abort.current = null;
      setWork(null);
    }
  }

  const audienceLabel = audience.kind === 'connections' ? t('feed.toConnections')
    : audience.kind === 'only_me' ? t('feed.toOnlyMe')
    : audience.kind === 'close' ? t('close.audience')
    : audience.kind === 'followers' ? t('follow.aud.followers')
    : audience.kind === 'public' ? t('follow.aud.public')
    : audience.kind === 'circle' ? (circles.find((c) => c.id === audience.circleId)?.name ?? t('feed.audienceCircle'))
    : t('feed.audienceEvent');
  const audienceIcon = audience.kind === 'only_me' ? 'lock' : audience.kind === 'close' ? 'heart' : audience.kind === 'circle' ? 'circles'
    : audience.kind === 'followers' ? 'userCheck' : audience.kind === 'public' ? 'globe' : 'users';
  const sizeText = formatBytes(estimate, f.number);
  const canShare = !!src && keysReady && length >= 1 && (canEncode || verdict === 'ok');
  const workLabel = !work ? '' : work.phase === 'encode' ? t('reels.make.encoding', { pct: work.pct ?? 0 })
    : work.phase === 'encrypt' ? t('feed.encrypting') : work.phase === 'upload' ? t('feed.uploading', { pct: work.pct ?? 0 }) : t('feed.sharing');
  const busy = step === 'work';
  const range = (v: number) => formatDuration(Math.max(v, 0.5)) || '0:00';

  return (
    <>
      <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={t('reels.make.title')} dismissible={!busy} className="k-reelmake"
        footer={step === 'edit' ? (
          <>
            <Button variant="ghost" onClick={() => { setSrc(null); setCover(null); setStep('pick'); }}>{t('reels.make.another')}</Button>
            <Button variant="primary" icon="reel" disabled={!canShare} onClick={() => void share()}>{t('reels.make.share')}</Button>
          </>
        ) : step === 'work' ? (
          <Button variant="ghost" onClick={() => abort.current?.abort()}>{t('feed.cancel')}</Button>
        ) : undefined}>
        <div className="k-stack">
          {err ? <p className="k-error" role="alert"><Icon name="alert" />{err}</p> : null}

          {step === 'pick' ? (
            <>
              <p className="k-muted k-small">{t('reels.make.intro')}</p>
              <input ref={fileInput} type="file" accept="video/mp4,video/webm,video/quicktime,video/*" hidden onChange={(e) => void choose(e.target.files?.[0])} />
              <div className="k-reelmake-pick">
                <button type="button" className="k-reelmake-choice" disabled={reading} onClick={() => fileInput.current?.click()}>
                  <Icon name="video" /><span>{t('reels.make.choose')}</span>
                </button>
                <button type="button" className="k-reelmake-choice" disabled={reading} onClick={() => { setErr(null); setStep('record'); }}>
                  <Icon name="camera" /><span>{t('reels.make.record')}</span>
                </button>
              </div>
              {reading ? <p className="k-muted k-small" role="status"><Spinner size={16} /> {t('feed.videoReading')}</p> : null}
              {!canEncode ? <Callout tone="warning" icon="info">{t('reels.make.noEncoder', { size: formatBytes(maxBytes, f.number) })}</Callout> : null}
            </>
          ) : null}

          {step === 'record' ? (
            <>
              <input ref={cameraInput} type="file" accept="video/*" capture="environment" hidden onChange={(e) => void choose(e.target.files?.[0])} />
              <ReelRecorder onDone={(blob) => void choose(blob)} onBack={() => setStep('pick')} onCameraApp={() => cameraInput.current?.click()} />
              {reading ? <p className="k-muted k-small" role="status"><Spinner size={16} /> {t('feed.videoReading')}</p> : null}
            </>
          ) : null}

          {(step === 'edit' || step === 'work') && src ? (
            <>
              <div className="k-reelmake-stage" data-working={busy ? '' : undefined}>
                {/* The transcoder plays the video in this slot while it works (lib/reels/transcode openSource). */}
                <div ref={workSlot} className="k-reelmake-workslot" />
                <video ref={preview} className="k-reelmake-preview" src={src.url} muted playsInline preload="auto" hidden={busy}
                  onPlay={() => setPreviewPlaying(true)} onPause={() => setPreviewPlaying(false)}
                  onTimeUpdate={(e) => { const v = e.currentTarget; if (!v.paused && v.currentTime >= trim.end) v.currentTime = trim.start; }} />
                {!busy ? (
                  <button type="button" className="k-reelmake-play" onClick={togglePreview} aria-label={previewPlaying ? t('reels.pause') : t('reels.make.preview')}>
                    {previewPlaying ? null : <Icon name="play" />}
                  </button>
                ) : null}
              </div>

              {busy && work ? (
                <div className="k-composer-progress" role="status" aria-live="polite">
                  <span className="k-small">{workLabel}</span>
                  <span className="k-progress" role="progressbar" aria-label={workLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={work.pct ?? undefined}>
                    <span style={{ inlineSize: `${work.pct ?? 5}%` }} data-indeterminate={work.pct === undefined ? '' : undefined} />
                  </span>
                  <span className="k-xs k-muted">{work.phase === 'encode' ? t('reels.make.keepOpen') : t('reels.make.uploadNote')}</span>
                </div>
              ) : (
                <>
                  <fieldset className="k-reelmake-trim">
                    <legend className="k-label">{t('reels.make.trim')}</legend>
                    <label htmlFor={`${ids}-s`} className="k-small">{t('reels.make.trimStart')}</label>
                    <input id={`${ids}-s`} type="range" min={0} max={src.info.duration} step={0.1} value={trim.start} dir="ltr"
                      aria-valuetext={range(trim.start)} onChange={(e) => moveTrim('start', Number(e.target.value))} />
                    <label htmlFor={`${ids}-e`} className="k-small">{t('reels.make.trimEnd')}</label>
                    <input id={`${ids}-e`} type="range" min={0} max={src.info.duration} step={0.1} value={trim.end} dir="ltr"
                      aria-valuetext={range(trim.end)} onChange={(e) => moveTrim('end', Number(e.target.value))} />
                    <p className="k-small k-muted" aria-live="polite">
                      {t('reels.make.trimInfo', { from: range(trim.start), to: range(trim.end), seconds: Math.round(length) })}
                      {src.info.duration > REEL_MAX_SECONDS ? ` ${t('reels.make.trimMax')}` : ''}
                    </p>
                  </fieldset>

                  <div className="k-reelmake-cover">
                    <span className="k-reelmake-cover-th">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {coverUrl ? <img src={coverUrl} alt={t('reels.make.coverAlt')} /> : <Spinner size={16} />}
                    </span>
                    <span className="k-reelmake-cover-pick">
                      <label htmlFor={`${ids}-c`} className="k-label">{t('reels.make.cover')}</label>
                      <input id={`${ids}-c`} type="range" min={trim.start} max={Math.max(trim.start, trim.end - 0.1)} step={0.1} value={coverAt} dir="ltr"
                        aria-valuetext={range(coverAt)} onChange={(e) => setCoverAt(Number(e.target.value))} />
                    </span>
                  </div>

                  <Textarea label={t('reels.make.caption')} hint={t('reels.make.captionHint')} value={caption} rows={2} maxLength={REEL_CAPTION_MAX} dir="auto"
                    onChange={(e) => setCaption(e.target.value)} />

                  <div className="k-row-wrap">
                    <span className="k-label">{t('feed.audiencePicker')}</span>
                    {fixedAudience ? (
                      <span className="k-chip"><Icon name={audienceIcon} />{audienceLabel}</span>
                    ) : (
                      <button type="button" className="k-chip k-chip-btn" aria-haspopup="dialog" onClick={() => setPicking(true)}
                        aria-label={`${t('feed.audiencePicker')} ${audienceLabel}`}>
                        <Icon name={audienceIcon} /><span>{audienceLabel}</span><Icon name="down" />
                      </button>
                    )}
                  </div>
                  {audience.kind === 'public' ? <p className="k-public-note k-small" role="note"><Icon name="globe" /> {t('follow.public.composerNote')}</p>
                    : <p className="k-small k-muted"><Icon name="lock" /> {t('reels.make.encryptedNote')}</p>}

                  <p className="k-small k-muted">
                    {canEncode ? t('reels.make.size', { size: sizeText, height: Math.min(plan.w, plan.h) }) : t('reels.make.sizeOriginal', { size: sizeText })}
                  </p>
                  {saver || onMobileData() ? <Callout tone="warning" icon="info">{t(saver ? 'reels.make.saverWarn' : 'reels.make.mobileWarn', { size: sizeText })}</Callout> : null}
                  {verdict && verdict !== 'ok' ? <Callout tone="danger" icon="alert">{t('reels.make.cantShrink')} {t(ORIGINAL[verdict], { size: formatBytes(maxBytes, f.number) })}</Callout> : null}
                  {verdict === 'ok' ? <Callout tone="warning" icon="info">{t('reels.make.origOk')}</Callout> : null}
                  {!keysReady ? <p className="k-muted k-small" role="status"><Icon name="lock" />{t('feed.preparingKeys')}</p> : null}
                </>
              )}
            </>
          ) : null}
        </div>
      </Dialog>

      {!fixedAudience ? (
        <Dialog open={picking} onClose={() => setPicking(false)} title={t('feed.audiencePicker')} sheet>
          <AudienceOptions value={audience} circles={circles} onPick={(a) => { setAudience(a); setPicking(false); }}
            follow={followOn ? { publicOn, tooNew, minAgeHours } : undefined} />
        </Dialog>
      ) : null}
      <Dialog open={intro} onClose={() => setIntro(false)} title={t('follow.public.introTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => setIntro(false)}>{t('feed.cancel')}</Button>
          <Button variant="primary" icon="globe" onClick={() => {
            setIntro(false);
            void markPublicExplained().catch(() => undefined).then(() => share(true));
          }}>{t('follow.public.introConfirm')}</Button>
        </>}>
        <div className="k-stack">
          <Callout tone="warning" icon="globe">{t('follow.public.introBody')}</Callout>
          <p className="k-small k-muted">{t('follow.public.introMore')}</p>
        </div>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------------------------- recording
type CamState = 'starting' | 'ready' | 'recording' | 'denied' | 'unavailable';

/**
 * Record up to a minute with the device's camera and microphone, inside the app (getUserMedia +
 * MediaRecorder). The recording stays on this device until it has been trimmed and re-encoded like a picked
 * video. Where the browser offers no camera here, the system camera app can be opened instead.
 */
function ReelRecorder({ onDone, onBack, onCameraApp }: { onDone: (video: Blob) => void; onBack: () => void; onCameraApp: () => void }) {
  const t = useT();
  const [state, setState] = useState<CamState>('starting');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [secs, setSecs] = useState(0);
  const view = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });

  useEffect(() => {
    let live = true;
    const type = recorderType();
    if (!navigator.mediaDevices?.getUserMedia || !type) { setState('unavailable'); return; }
    setState('starting');
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    }).then((s) => {
      if (!live) { s.getTracks().forEach((x) => x.stop()); return; }
      stream.current = s;
      if (view.current) { view.current.srcObject = s; void view.current.play().catch(() => undefined); }
      setState('ready');
    }).catch((e: unknown) => {
      if (!live) return;
      const name = (e as { name?: string } | null)?.name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    });
    return () => {
      live = false;
      if (tick.current) { clearInterval(tick.current); tick.current = null; }
      const r = rec.current;
      rec.current = null;
      if (r && r.state !== 'inactive') { r.ondataavailable = null; r.onstop = null; try { r.stop(); } catch { /* already stopped */ } }
      stream.current?.getTracks().forEach((x) => x.stop());
      stream.current = null;
    };
  }, [facing]);

  function start() {
    const s = stream.current;
    const type = recorderType();
    if (!s || !type || rec.current) return;
    const parts: Blob[] = [];
    const r = new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => {
      rec.current = null;
      if (tick.current) { clearInterval(tick.current); tick.current = null; }
      const blob = new Blob(parts, { type: type.split(';')[0] });
      if (blob.size) done.current(blob);
    };
    rec.current = r;
    r.start(1000);
    setSecs(0);
    setState('recording');
    const began = Date.now();
    tick.current = setInterval(() => {
      const n = Math.floor((Date.now() - began) / 1000);
      setSecs(n);
      if (n >= REEL_MAX_SECONDS) stop();
    }, 250);
  }

  function stop() {
    const r = rec.current;
    if (r && r.state !== 'inactive') r.stop();
    setState('ready');
  }

  if (state === 'denied' || state === 'unavailable') {
    return (
      <div className="k-stack">
        <Callout tone="warning" icon="camera">{t(state === 'denied' ? 'reels.rec.denied' : 'reels.rec.unavailable')}</Callout>
        <div className="k-row-wrap">
          <Button variant="secondary" icon="camera" onClick={onCameraApp}>{t('reels.rec.cameraApp')}</Button>
          <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>
        </div>
      </div>
    );
  }
  const recording = state === 'recording';
  return (
    <div className="k-stack">
      <div className="k-reelmake-stage k-reelmake-cam" data-mirror={facing === 'user' ? '' : undefined}>
        <video ref={view} className="k-reelmake-preview" muted playsInline autoPlay aria-label={t('reels.rec.preview')} />
        {state === 'starting' ? <span className="k-reelmake-camwait" role="status"><Spinner /> {t('reels.rec.starting')}</span> : null}
        <span className="k-reelmake-timer k-ltr" role="timer" aria-live="off" data-on={recording ? '' : undefined}>
          {formatDuration(Math.max(secs, 0.5)) || '0:00'} / {formatDuration(REEL_MAX_SECONDS)}
        </span>
      </div>
      <div className="k-reelmake-recbar">
        <IconButton icon="back" label={t('common.back')} disabled={recording} onClick={onBack} />
        <button type="button" className="k-reelmake-rec" data-on={recording ? '' : undefined} disabled={state === 'starting'}
          onClick={recording ? stop : start} aria-label={recording ? t('reels.rec.stop') : t('reels.rec.start')} aria-pressed={recording} />
        <IconButton icon="refresh" label={t('reels.rec.flip')} disabled={recording || state === 'starting'} onClick={() => setFacing((x) => (x === 'user' ? 'environment' : 'user'))} />
      </div>
      <p className="k-small k-muted k-center">{t('reels.rec.note')}</p>
    </div>
  );
}
