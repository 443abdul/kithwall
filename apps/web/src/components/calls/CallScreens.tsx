'use client';
// Call screens (docs/v2/04-calls.md §7): incoming call, in-call (1:1 stage with a self-view, or a grid for
// groups), a minimised bar that follows you around the app, and the encryption panel with the call's
// safety code. Phone-first (375px), RTL-safe (logical properties only), keyboard and screen-reader usable.
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { calls, type CallSnapshot, type PeerView } from '@/lib/calls/engine';
import { people, usePeopleVersion } from '@/lib/people';
import { useSession } from '@/lib/keys/session';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/cx';
import { ConversationAvatar, PersonAvatar, useConversationTitle, useNameOf } from '@/components/messages/look';
import { CallIcon, type CallIconName } from './CallIcon';
import { CallCheck } from './CallCheck';
import { CallDevices } from './CallDevices';

// ------------------------------------------------------------------------------------------ helpers

/** The current time, refreshed every second while `on`. */
function useNow(on: boolean): number {
  const [now, set] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const h = setInterval(() => set(Date.now()), 1000);
    return () => clearInterval(h);
  }, [on]);
  return now;
}

export function useDuration(since: number | null): string {
  const f = useFormat();
  const now = useNow(!!since);
  if (!since) return '';
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const two = (n: number) => f.number(n, { minimumIntegerDigits: 2, useGrouping: false });
  return h ? `${f.number(h)}:${two(m)}:${two(s)}` : `${f.number(m)}:${two(s)}`;
}

function Media({ stream, muted, mirror, className, label }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} className={cx('k-call-video', mirror && 'is-mirror', className)} autoPlay playsInline muted={muted} aria-label={label} />;
}

/** Remote audio, one element per person (so the output device can be chosen where browsers allow it). */
function PeerAudio({ stream, sinkId }: { stream: MediaStream; sinkId: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (a.srcObject !== stream) a.srcObject = stream;
    void a.play().catch(() => undefined);
  }, [stream]);
  useEffect(() => {
    // '' is the system default: set it too, so a speaker that was pulled out (or a choice reset) takes effect.
    const a = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }) | null;
    if (a?.setSinkId && (sinkId || a.sinkId)) void a.setSinkId(sinkId).catch(() => undefined);
  }, [sinkId]);
  return <audio ref={ref} autoPlay className="k-call-audio" />;
}

function CtlButton({ icon, label, onClick, pressed, tone, big }: { icon: CallIconName; label: string; onClick: () => void; pressed?: boolean; tone?: 'danger' | 'accept'; big?: boolean }) {
  return (
    <button type="button" className={cx('k-call-ctl', tone && `is-${tone}`, pressed && 'is-on', big && 'is-big')} onClick={onClick}
      aria-label={label} title={label} aria-pressed={pressed === undefined ? undefined : pressed}>
      <CallIcon name={icon} />
    </button>
  );
}

/** Connection bars from the quality controller (lib/calls/quality.ts), with the reason when it isn't good. */
function QualityBars({ q, reason }: { q: PeerView['quality']; reason?: PeerView['reason'] }) {
  const t = useT();
  if (!q) return null;
  const n = q === 'good' ? 3 : q === 'fair' ? 2 : 1;
  const label = q !== 'good' && reason
    ? t('calls.quality.withReason', { quality: t(`calls.quality.${q}` as MessageKey), reason: t(`calls.reason.${reason}` as MessageKey) })
    : t(`calls.quality.${q}` as MessageKey);
  return (
    <span className={cx('k-call-quality', `is-${q}`)} role="img" aria-label={label} title={label}>
      {[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'is-on' : undefined} />)}
    </span>
  );
}

function endKey(s: CallSnapshot): MessageKey {
  switch (s.m.reason) {
    case 'declined': case 'rejected': return 'calls.ended.declined';
    case 'busy': return 'calls.ended.busy';
    case 'no-answer': return 'calls.ended.noAnswer';
    case 'missed': return 'calls.ended.missed';
    case 'elsewhere': return 'calls.ended.elsewhere';
    case 'failed': return 'calls.ended.failed';
    case 'no-media': return 'calls.ended.noMedia';
    case 'relay': return 'calls.ended.relay';
    case 'over': return 'calls.ended.over';
    default: return 'calls.ended.ended';
  }
}

/** The line that explains an ending that needs explaining, with what to do about it. */
function endDetail(s: CallSnapshot): MessageKey | null {
  if (s.m.reason === 'no-media') return s.mediaError ? (`calls.media.${s.mediaError}` as MessageKey) : 'calls.media.other';
  if (s.m.reason === 'relay') return 'calls.ended.relayBody';
  if (s.m.reason === 'failed') return 'calls.ended.failedBody';
  return null;
}

function useStatus(s: CallSnapshot, peer: PeerView | null): string {
  const t = useT();
  const duration = useDuration(s.m.phase === 'active' ? s.connectedAt : null);
  if (s.m.phase === 'ended') return t(endKey(s));
  if (s.m.phase === 'outgoing') return t(s.progress === 'ringing' ? 'calls.status.ringing' : s.progress === 'connecting' ? 'calls.status.connecting' : 'calls.status.calling');
  if (s.m.phase === 'connecting') return t('calls.status.connecting');
  if (peer && peer.state === 'reconnecting') return t('calls.status.reconnecting');
  return duration;
}

/** "Dan joined the call" / "Dan left the call" (someone joining or leaving a call that's going on). */
function useEventText(): (e: NonNullable<CallSnapshot['event']>) => string {
  const t = useT();
  const nameOf = useNameOf();
  return (e) => t(e.kind === 'joined' ? 'calls.people.joined' : 'calls.people.left', { name: nameOf(e.userId) });
}

// ------------------------------------------------------------------------------------------ incoming

function Incoming({ s }: { s: CallSnapshot }) {
  const t = useT();
  const nameOf = useNameOf();
  const title = useConversationTitle(s.conv);
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => { accept.current?.focus(); }, []);
  const group = !!s.conv && !s.conv.isDm && s.conv.members.length > 2;
  const who = s.masked ? t('calls.maskedTitle') : group ? title : s.caller ? nameOf(s.caller) : title;
  const sub = s.masked ? t('calls.sealed')
    : group && s.caller ? t('calls.incomingGroup', { name: nameOf(s.caller) })
      : t(s.video ? 'calls.incomingVideo' : 'calls.incomingVoice');
  return (
    <div className="k-call-incoming" role="alertdialog" aria-modal="true" aria-labelledby="k-call-in-title" aria-describedby="k-call-in-sub">
      <div className="k-call-incoming-who">
        {s.masked ? <span className="k-call-masked" aria-hidden><Icon name="lock" /></span>
          : group && s.conv ? <ConversationAvatar c={s.conv} size={96} /> : <PersonAvatar id={s.caller} size={96} />}
        <h2 id="k-call-in-title" className="k-call-name">{who}</h2>
        <p id="k-call-in-sub" className="k-call-sub">{sub}</p>
        <p className="k-call-sealed"><Icon name="lock" /> {t('calls.sealed')}</p>
      </div>
      <div className="k-call-incoming-actions">
        <span className="k-call-action">
          <CtlButton icon="hangup" tone="danger" big label={t('calls.decline')} onClick={() => calls.decline()} />
          <span aria-hidden>{t('calls.decline')}</span>
        </span>
        <span className="k-call-action">
          <button ref={accept} type="button" className="k-call-ctl is-accept is-big" onClick={() => void calls.accept()}
            aria-label={t(s.video ? 'calls.acceptVideo' : 'calls.accept')} title={t(s.video ? 'calls.acceptVideo' : 'calls.accept')}>
            <CallIcon name={s.video ? 'video' : 'phone'} />
          </button>
          <span aria-hidden>{t('calls.accept')}</span>
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ in call

function Tile({ peer, sinkId, big, voiceOnly }: { peer: PeerView; sinkId: string; big?: boolean; voiceOnly?: boolean }) {
  const t = useT();
  const nameOf = useNameOf();
  const name = nameOf(peer.userId);
  // Their video paused for the network, or I chose voice only: show the avatar, never a frozen frame.
  const paused = peer.cam && (peer.videoPaused || !!voiceOnly);
  const showVideo = peer.cam && !paused && peer.stream.getVideoTracks().length > 0;
  return (
    <div className={cx('k-call-tile', big && 'is-big', peer.state !== 'connected' && 'is-waiting')}>
      {showVideo ? <Media stream={peer.stream} muted label={t('calls.videoOf', { name })} /> : (
        <div className="k-call-tile-avatar">
          <PersonAvatar id={peer.userId} size={big ? 112 : 72} />
          {paused && peer.videoPaused && !voiceOnly ? <p className="k-call-tile-note">{t('calls.videoPaused')}</p> : null}
        </div>
      )}
      <PeerAudio stream={peer.stream} sinkId={sinkId} />
      <span className="k-call-tile-name">
        {!peer.mic ? <span className="k-call-tile-muted" role="img" aria-label={t('calls.mutedName', { name })}><CallIcon name="micOff" size={14} /></span> : null}
        <span dir="auto">{name}</span>
        <QualityBars q={peer.quality} reason={peer.reason} />
      </span>
    </div>
  );
}

function SelfView({ s, grid }: { s: CallSnapshot; grid?: boolean }) {
  const t = useT();
  const [corner, setCorner] = useState<'end' | 'start'>('end');
  const { userId } = useSession();
  if (grid) {
    return (
      <div className="k-call-tile is-self">
        {s.cam ? <Media stream={s.local} muted mirror={s.facing === 'user'} label={t('calls.localVideo')} />
          : <div className="k-call-tile-avatar"><PersonAvatar id={userId} size={72} /></div>}
        <span className="k-call-tile-name">{!s.mic ? <CallIcon name="micOff" size={14} /> : null}<span>{t('calls.you')}</span></span>
      </div>
    );
  }
  if (!s.cam) return null;
  return (
    <button type="button" className={cx('k-call-pip', corner === 'start' && 'is-start')} onClick={() => setCorner((c) => (c === 'end' ? 'start' : 'end'))}
      aria-label={t('calls.movePip')} title={t('calls.movePip')}>
      <Media stream={s.local} muted mirror={s.facing === 'user'} label={t('calls.localVideo')} />
    </button>
  );
}

function useHasTwoCameras(on: boolean): boolean {
  const [two, setTwo] = useState(false);
  useEffect(() => {
    if (!on || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((d) => setTwo(d.filter((x) => x.kind === 'videoinput').length > 1), () => undefined);
  }, [on]);
  return two;
}

function InCall({ s }: { s: CallSnapshot }) {
  const t = useT();
  const nameOf = useNameOf();
  usePeopleVersion();
  const eventText = useEventText();
  const title = useConversationTitle(s.conv);
  const [security, setSecurity] = useState(false);
  const [devices, setDevices] = useState(false);
  const twoCams = useHasTwoCameras(s.cam);
  const group = s.peers.length > 1 || (!!s.conv && !s.conv.isDm && s.conv.members.length > 2);
  const main = s.peers[0] ?? null;
  const status = useStatus(s, main);
  const ended = s.m.phase === 'ended';
  const hangRef = useRef<HTMLDivElement>(null);
  useEffect(() => { hangRef.current?.querySelector<HTMLButtonElement>('.is-danger')?.focus(); }, []);
  const who = group ? title : s.peers[0] ? nameOf(s.peers[0].userId) : title;
  const [check, setCheck] = useState(false);
  const detail = ended ? endDetail(s) : null;
  const canRetry = ended && s.isCaller && (s.m.reason === 'failed' || s.m.reason === 'relay' || s.m.reason === 'no-media');
  const weak = s.m.phase === 'active' && s.weak
    ? s.weak.who === 'me' ? t('calls.weak.mine') : s.weak.who === 'peer' ? t('calls.weak.theirs', { name: nameOf(s.weak.userId) }) : null
    : null;

  return (
    <div className={cx('k-call-screen', group ? 'is-group' : 'is-one', ended && 'is-ended')} role="dialog" aria-modal="true" aria-labelledby="k-call-title"
      data-call-phase={s.m.phase} data-call-e2ee={s.frameMode && s.peers.some((p) => p.frames) ? 'frames' : 'dtls'}>
      <header className="k-call-top">
        <button type="button" className="k-call-topbtn" onClick={() => calls.setMinimized(true)} aria-label={t('calls.minimize')} title={t('calls.minimize')} disabled={ended}>
          <CallIcon name="minimize" />
        </button>
        <div className="k-call-top-text">
          <h2 id="k-call-title" className="k-call-title" dir="auto">{who}</h2>
          <p className="k-call-status" aria-live="polite">{status}</p>
          {weak ? <p className="k-call-weak" role="status">{weak}</p> : null}
          {!ended && s.camError ? <p className="k-call-weak" role="status">{t('calls.camError')}</p> : null}
          {!ended && s.event ? <p className="k-call-event">{eventText(s.event)}</p> : null}
        </div>
        <button type="button" className="k-call-topbtn k-call-lock" onClick={() => setSecurity(true)} aria-label={t('calls.security.open')} title={t('calls.security.open')}>
          <CallIcon name="shield" />
        </button>
      </header>

      <div className={cx('k-call-stage', group && 'k-call-grid', group && `n-${Math.min(s.peers.length + 1, 9)}`)}>
        {group ? (
          <>
            {s.peers.map((p) => <Tile key={p.ep} peer={p} sinkId={s.sinkId} voiceOnly={s.voiceOnly} />)}
            <SelfView s={s} grid />
          </>
        ) : main ? (
          <>
            <Tile peer={main} sinkId={s.sinkId} big voiceOnly={s.voiceOnly} />
            <SelfView s={s} />
          </>
        ) : (
          <div className="k-call-waiting">
            {s.conv ? <ConversationAvatar c={s.conv} size={112} /> : null}
            <p className="k-call-sealed"><Icon name="lock" /> {t('calls.sealed')}</p>
            <SelfView s={s} />
          </div>
        )}
      </div>

      {ended && (detail || canRetry || s.m.reason === 'no-media') ? (
        <div className="k-call-banner" role="alert">
          {detail ? <p className="k-call-detail">{t(detail)}</p> : null}
          <div className="k-call-ended-actions">
            {canRetry ? <button type="button" className="k-call-banner-btn is-primary" onClick={() => calls.retry()}>{t('calls.retry')}</button> : null}
            {s.m.reason === 'no-media' ? <button type="button" className="k-call-banner-btn" onClick={() => setCheck(true)}>{t('calls.check.open')}</button> : null}
          </div>
        </div>
      ) : null}

      {s.suggestVoice && !ended ? (
        <div className="k-call-banner" role="alert">
          <p>{t('calls.weak.suggest')}</p>
          <div className="k-call-banner-actions">
            <button type="button" className="k-call-banner-btn is-primary" onClick={() => void calls.voiceOnly()}>{t('calls.weak.switch')}</button>
            <button type="button" className="k-call-banner-btn" onClick={() => calls.dismissSuggestion()}>{t('calls.weak.dismiss')}</button>
          </div>
        </div>
      ) : null}

      <div className="k-call-controls" ref={hangRef}>
        <CtlButton icon={s.mic ? 'mic' : 'micOff'} label={s.mic ? t('calls.mute') : t('calls.unmute')} pressed={!s.mic} onClick={() => calls.toggleMic()} />
        <CtlButton icon={s.cam ? 'video' : 'videoOff'} label={s.cam ? t('calls.cameraOff') : t('calls.cameraOn')} pressed={s.cam} onClick={() => void calls.toggleCam()} />
        {s.cam && twoCams ? <CtlButton icon="flip" label={t('calls.switchCamera')} onClick={() => void calls.switchCamera()} /> : null}
        {!ended ? <CtlButton icon="devices" label={t('calls.devices.open')} onClick={() => setDevices(true)} /> : null}
        <CtlButton icon="saver" label={s.saver ? t('calls.saver.off') : t('calls.saver.on')} pressed={s.saver} onClick={() => calls.setSaver(!s.saver)} />
        <CtlButton icon="hangup" tone="danger" label={t('calls.hangup')} onClick={() => (ended ? calls.dismiss() : calls.hangup())} />
      </div>

      <SecurityPanel s={s} open={security} onClose={() => setSecurity(false)} />
      <CallCheck open={check} onClose={() => setCheck(false)} />
      <CallDevices s={s} open={devices && !ended} onClose={() => setDevices(false)} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------ encryption

function SecurityPanel({ s, open, onClose }: { s: CallSnapshot; open: boolean; onClose: () => void }) {
  const t = useT();
  const f = useFormat();
  const nameOf = useNameOf();
  const frames = !!s.frameMode && s.peers.some((p) => p.frames);
  return (
    <Dialog open={open} onClose={onClose} title={t('calls.security.title')} sheet className="k-call-security">
      <div className="k-stack">
        {s.peers.length ? s.peers.map((p) => {
          const name = nameOf(p.userId);
          const handle = people.get(p.userId)?.username;
          return (
            <section key={p.ep} className="k-call-code" aria-label={name}>
              <p className="k-call-code-who" dir="auto">{name}</p>
              {p.safety ? (
                <>
                  <p className="k-call-emoji" role="img" aria-label={t('calls.security.codeLabel', { digits: p.safety.digits })}>
                    {p.safety.emoji.map((e, i) => <span key={i}>{e}</span>)}
                  </p>
                  <p className="k-call-digits" aria-hidden>{[...p.safety.digits].map((d) => f.number(Number(d))).join('')}</p>
                  <p className="k-small">{t('calls.security.code', { name })}</p>
                </>
              ) : <p className="k-small k-muted">{t('calls.security.waiting')}</p>}
              {handle ? (
                <Link className="k-link k-small" href={`/u/${handle}/verify`} onClick={() => { onClose(); calls.setMinimized(true); }}>
                  {t('calls.security.verify', { name })}
                </Link>
              ) : null}
            </section>
          );
        }) : <p className="k-small k-muted">{t('calls.security.waiting')}</p>}
        <ul className="k-call-facts">
          <li><Icon name="lock" /> <span>{frames ? t('calls.security.frames') : t('calls.security.dtls')}</span></li>
          <li><Icon name={s.relay === 'on' ? 'shield' : 'alert'} /> <span>{t(s.relay === 'on' ? 'calls.security.relayOn' : s.relay === 'off' ? 'calls.security.relayOff' : 'calls.security.relayUnavailable')}</span></li>
        </ul>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------ bar

function CallBar({ s }: { s: CallSnapshot }) {
  const t = useT();
  const nameOf = useNameOf();
  const title = useConversationTitle(s.conv);
  const group = s.peers.length > 1 || (!!s.conv && !s.conv.isDm && s.conv.members.length > 2);
  const status = useStatus(s, s.peers[0] ?? null);
  const who = group ? title : s.peers[0] ? nameOf(s.peers[0].userId) : title;
  return (
    <div className="k-call-bar" role="region" aria-label={t('calls.barLabel')}>
      {s.peers.map((p) => <PeerAudio key={p.ep} stream={p.stream} sinkId={s.sinkId} />)}
      <button type="button" className="k-call-bar-main" onClick={() => calls.setMinimized(false)} aria-label={`${t('calls.expand')}: ${who}`}>
        <span className="k-call-bar-dot" aria-hidden />
        <span className="k-call-bar-who" dir="auto">{who}</span>
        <span className="k-call-bar-time" aria-live="off">{status}</span>
      </button>
      <CtlButton icon={s.mic ? 'mic' : 'micOff'} label={s.mic ? t('calls.mute') : t('calls.unmute')} pressed={!s.mic} onClick={() => calls.toggleMic()} />
      <CtlButton icon="hangup" tone="danger" label={t('calls.hangup')} onClick={() => calls.hangup()} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------ root

export function CallScreens({ s }: { s: CallSnapshot }): ReactNode {
  const t = useT();
  const eventText = useEventText();
  const phase = s.m.phase;
  // The status line is itself aria-live; this only announces the moment the call connects, and who
  // joins or leaves later (also while the call is minimised).
  const announce = phase === 'active' ? (s.event ? eventText(s.event) : t('calls.announce.connected')) : '';
  let body: ReactNode = null;
  if (phase === 'incoming') body = <Incoming s={s} />;
  else if (phase !== 'idle') body = s.minimized && phase !== 'ended' ? <CallBar s={s} /> : <InCall s={s} />;
  return (
    <>
      {body}
      <p className="k-sr-only" role="status" aria-live="polite">{announce}</p>
    </>
  );
}
