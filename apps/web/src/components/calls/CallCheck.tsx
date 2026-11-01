'use client';
// "Test camera and microphone" (docs/v2/04-calls.md §12): see yourself, watch the microphone level, pick
// the microphone / camera / speaker calls use, play a test sound. Nothing is recorded or sent anywhere:
// the stream stays on this page and is stopped when the dialog closes. Choices are kept on this device
// (lib/calls/devices.ts). Opened from Settings → Privacy → Calls and from a call that couldn't use the
// microphone.
import { useEffect, useId, useRef, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { getCallDevices, mediaErr, micConstraints, setCallDevices, type MediaErr } from '@/lib/calls/devices';

/** One device list (shown only when there is a choice), with "Default" first. Also used by CallDevices. */
export function DeviceSelect({ label, value, devices, onChange }: { label: string; value: string; devices: MediaDeviceInfo[]; onChange: (id: string) => void }) {
  const t = useT();
  const id = useId();
  if (devices.length < 2) return null;
  return (
    <div className="k-field">
      <label className="k-label" htmlFor={id}>{label}</label>
      <div className="k-control kc-select">
        <select id={id} className="k-input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('calls.check.default')}</option>
          {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
        </select>
        <span className="k-control-affix" aria-hidden><Icon name="down" /></span>
      </div>
    </div>
  );
}

const ERR: Record<MediaErr, MessageKey> = {
  denied: 'calls.media.denied', missing: 'calls.media.missing', busy: 'calls.media.busy', other: 'calls.media.other',
};

function Check() {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [devs, setDevs] = useState(getCallDevices);
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  const [err, setErr] = useState<MediaErr | null>(null);
  const [camErr, setCamErr] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    let live = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    void (async () => {
      const audio = micConstraints();
      const cam: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 360 }, ...(devs.cam ? { deviceId: { ideal: devs.cam } } : { facingMode: 'user' }) };
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio, video: cam }); setCamErr(false); } catch {
          stream = await navigator.mediaDevices.getUserMedia({ audio });
          setCamErr(true);
        }
      } catch (e) { if (live) setErr(mediaErr(e)); return; }
      if (!live) { stream.getTracks().forEach((x) => x.stop()); return; }
      setErr(null);
      if (video.current) { video.current.srcObject = stream; void video.current.play().catch(() => undefined); }
      setList(await navigator.mediaDevices.enumerateDevices().catch(() => []));
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let last = 0;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (now - last < 100) return;
        last = now;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(100, Math.round((peak / 128) * 160)));
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((x) => x.stop());
      void ctx?.close().catch(() => undefined);
    };
  }, [devs.mic, devs.cam]);

  const pick = (k: 'mic' | 'cam' | 'out') => (id: string) => {
    setCallDevices({ [k]: id || undefined });
    setDevs(getCallDevices());
  };

  const testSound = async () => {
    const ctx = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (devs.out && ctx.setSinkId) await ctx.setSinkId(devs.out).catch(() => undefined);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.85);
    o.onended = () => { void ctx.close().catch(() => undefined); };
  };

  const by = (kind: MediaDeviceKind) => list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const canPickOut = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  return (
    <div className="k-stack k-call-check">
      <p className="k-small k-muted">{t('calls.check.body')}</p>
      {err ? <p className="k-call-check-err" role="alert"><Icon name="alert" /> {t(ERR[err])}</p> : (
        <>
          <div className="k-call-check-preview">
            {camErr ? <p className="k-small k-muted">{t('calls.check.noCamera')}</p> : null}
            <video ref={video} className="k-call-video is-mirror" autoPlay playsInline muted aria-label={t('calls.localVideo')} />
          </div>
          <div className="k-call-check-level">
            <span className="k-small">{t('calls.check.level')}</span>
            <span className="k-call-meter" role="meter" aria-label={t('calls.check.level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
              <i style={{ inlineSize: `${level}%` }} />
            </span>
            <span className="k-small k-muted">{t('calls.check.speak')}</span>
          </div>
        </>
      )}
      <DeviceSelect label={t('calls.check.mic')} value={devs.mic ?? ''} devices={by('audioinput')} onChange={pick('mic')} />
      <DeviceSelect label={t('calls.check.cam')} value={devs.cam ?? ''} devices={by('videoinput')} onChange={pick('cam')} />
      {canPickOut ? <DeviceSelect label={t('calls.check.out')} value={devs.out ?? ''} devices={by('audiooutput')} onChange={pick('out')} /> : null}
      <div><Button size="sm" icon="play" onClick={() => void testSound()}>{t('calls.check.sound')}</Button></div>
    </div>
  );
}

/** The dialog; the camera and microphone are only opened while it is open. */
export function CallCheck({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t('calls.check.title')} sheet footer={<Button variant="primary" onClick={onClose}>{t('common.done')}</Button>}>
      {open ? <Check /> : null}
    </Dialog>
  );
}
