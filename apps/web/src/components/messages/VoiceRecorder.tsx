'use client';
// Voice-note recording in the chat composer (Kithwall 2 phase 4).
//  - Hold the mic: records while held; release to preview; slide towards the start edge to cancel; slide up to
//    lock (keep recording hands-free).
//  - Tap the mic (or press Enter/Space on it): records hands-free; Stop shows the preview.
//  - Preview: play it back, delete it, or send it. Esc cancels at any point.
// The mic button stays mounted while it's held, so it keeps the pointer.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type MouseEvent } from 'react';
import { useFormat, useT } from '@/i18n';
import { clockParts, MAX_VOICE_SECS, type VoiceDraft } from '@/lib/chat/voice';
import type { VoiceRecorder } from '@/lib/chat/voiceRecorder';
import { cx } from '@/components/ui/cx';
import { VoiceIcon } from './VoiceIcon';
import { VoicePlayer } from './VoiceNote';

const CANCEL_PX = 110;
const LOCK_PX = 70;
const TAP_MS = 350;

function useClock() {
  const f = useFormat();
  return useCallback((secs: number) => {
    const { m, s } = clockParts(secs);
    return `${f.number(m)}:${f.number(s, { minimumIntegerDigits: 2 })}`;
  }, [f]);
}

export function VoiceMicButton({ rec, disabled, onDrag }: { rec: VoiceRecorder; disabled?: boolean; onDrag: (px: number) => void }) {
  const t = useT();
  const held = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const [lift, setLift] = useState(0);

  function down(e: PointerEvent<HTMLButtonElement>) {
    if (disabled || e.button !== 0 || rec.state !== 'idle') return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    held.current = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    onDrag(0); setLift(0);
    rec.start('hold');
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    const h = held.current;
    if (!h || h.id !== e.pointerId) return;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const towardStart = Math.max(0, (h.x - e.clientX) * (rtl ? -1 : 1));
    const up = Math.max(0, h.y - e.clientY);
    onDrag(towardStart); setLift(up);
    if (towardStart > CANCEL_PX) {
      held.current = null; onDrag(0); setLift(0);
      rec.cancel();
      try { navigator.vibrate?.(30); } catch { /* ignore */ }
    } else if (up > LOCK_PX) {
      held.current = null; onDrag(0); setLift(0);
      rec.lock();
    }
  }
  function up(e: PointerEvent<HTMLButtonElement>) {
    const h = held.current;
    if (!h || h.id !== e.pointerId) return;
    held.current = null; onDrag(0); setLift(0);
    // A quick tap, or a release while the browser was still asking for the microphone: record hands-free.
    if (performance.now() - h.t < TAP_MS || rec.state === 'starting') rec.lock();
    else rec.stop();
  }
  function cancelled(e: PointerEvent<HTMLButtonElement>) {
    const h = held.current;
    if (!h || h.id !== e.pointerId) return;
    held.current = null; onDrag(0); setLift(0);
    if (rec.state === 'starting') rec.lock(); else rec.cancel();
  }
  function click(e: MouseEvent<HTMLButtonElement>) {
    // Keyboard activation (Enter / Space) has no pointer: record hands-free.
    if (e.detail === 0 && !disabled && rec.state === 'idle') rec.start('locked');
  }

  const holding = rec.state !== 'idle' && rec.mode === 'hold';
  return (
    <span className={cx('k-voice-micwrap', holding && 'is-holding')}>
      {holding ? (
        <span className="k-voice-lockhint" aria-hidden style={{ transform: `translateY(${-Math.min(LOCK_PX, lift)}px)` }}>
          <VoiceIcon name="lock" size={16} /><VoiceIcon name="up" size={14} />
        </span>
      ) : null}
      <button type="button" className={cx('k-chat-send k-voice-mic', holding && 'is-holding')}
        aria-label={t('voice.record')} title={t('voice.recordHint')} disabled={disabled}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelled} onClick={click}
        onContextMenu={(e) => e.preventDefault()}>
        <VoiceIcon name="mic" />
      </button>
    </span>
  );
}

function LiveWave({ levels }: { levels: number[] }) {
  return (
    <span className="k-voice-live" aria-hidden>
      {levels.map((v, i) => <span key={i} className="k-voice-bar" style={{ blockSize: `${Math.max(8, Math.round(v * 100))}%` }} />)}
    </span>
  );
}

/** Replaces the composer row while recording or previewing. */
export function VoicePanel({ rec, drag, onSend }: { rec: VoiceRecorder; drag: number; onSend: (d: VoiceDraft) => void }) {
  const t = useT();
  const clock = useClock();
  const draft = rec.draft;
  const stopBtn = useRef<HTMLButtonElement>(null);
  const sendBtn = useRef<HTMLButtonElement>(null);

  // Esc cancels (recording) or deletes (preview).
  const { cancel } = rec;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel]);

  // Keep keyboard focus inside the panel as it changes.
  const locked = rec.mode === 'locked';
  useEffect(() => {
    if (rec.state === 'preview') sendBtn.current?.focus({ preventScroll: true });
    else if (rec.state === 'recording' && locked) stopBtn.current?.focus({ preventScroll: true });
  }, [rec.state, locked]);

  // Object URL for listening back before sending.
  const url = useMemo(() => (draft ? URL.createObjectURL(draft.blob) : null), [draft]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const load = useCallback(() => (url ? Promise.resolve(url) : Promise.reject(new Error('no recording'))), [url]);

  if (rec.state === 'preview' && draft) {
    return (
      <div className="k-voice-panel is-preview" role="group" aria-label={t('voice.ready')}>
        <span className="k-sr-only" role="status">{t('voice.ready')}{rec.hitLimit ? ` ${t('voice.limit')}` : ''}</span>
        <button type="button" className="k-iconbtn k-voice-discard" aria-label={t('voice.discard')} title={t('voice.discard')} onClick={rec.cancel}>
          <VoiceIcon name="trash" />
        </button>
        <div className="k-voice-previewbox">
          <VoicePlayer load={load} duration={draft.duration} peaks={draft.peaks} />
          {rec.hitLimit ? <span className="k-voice-limit k-xs">{t('voice.limit')}</span> : null}
        </div>
        <button ref={sendBtn} type="button" className="k-chat-send" aria-label={t('voice.send')} title={t('voice.send')}
          onClick={() => { const d = rec.take(); if (d) onSend(d); }}>
          <VoiceIcon name="send" />
        </button>
      </div>
    );
  }

  const near = Math.min(1, drag / CANCEL_PX);
  return (
    <div className={cx('k-voice-panel', locked ? 'is-locked' : 'is-holding')} role="group" aria-label={t('voice.recording')}>
      <span className="k-sr-only" role="status">{rec.state === 'recording' ? t('voice.recording') : ''}</span>
      {locked ? (
        <button type="button" className="k-iconbtn k-voice-discard" aria-label={t('voice.cancel')} title={t('voice.cancel')} onClick={rec.cancel}>
          <VoiceIcon name="trash" />
        </button>
      ) : null}
      <span className={cx('k-voice-rec', rec.state === 'recording' && 'is-on')} aria-hidden />
      <span className="k-voice-clock" dir="ltr" aria-hidden>{clock(rec.elapsed)}</span>
      {locked ? (
        <>
          <LiveWave levels={rec.live} />
          <span className="k-sr-only">{t('voice.remaining', { time: clock(MAX_VOICE_SECS - rec.elapsed) })}</span>
          <button ref={stopBtn} type="button" className="k-chat-send k-voice-stop" aria-label={t('voice.stop')} title={t('voice.stop')}
            onClick={rec.stop} disabled={rec.state !== 'recording'}>
            <VoiceIcon name="stop" />
          </button>
        </>
      ) : (
        <span className="k-voice-slide" style={{ opacity: 1 - near * 0.7, transform: `translateX(calc(${-drag}px * var(--k-dir, 1)))` }}>
          <VoiceIcon name="chevron" size={16} /> {t('voice.slideCancel')}
        </span>
      )}
    </div>
  );
}
