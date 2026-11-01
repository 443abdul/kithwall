'use client';
// The in-call device picker (docs/v2/04-calls.md §7): microphone, camera (front or back on phones) and,
// where the browser allows it (setSinkId), the speaker; in the Android app, loudspeaker or earpiece.
// A choice switches at once (lib/calls/engine.ts replaces the track on every connection, so the call's
// frame encryption and quality control carry on) and is remembered on this device (lib/calls/devices.ts),
// shared with "Test camera and microphone". The list follows devices being plugged in or pulled out.
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { Icon } from '@/components/ui/Icon';
import { calls, type CallSnapshot } from '@/lib/calls/engine';
import { isMobileUa } from '@/lib/calls/sdp';
import { isNative, nativePlatform } from '@/lib/native';
import { DeviceSelect } from './CallCheck';

/** Real devices only: the browser's "default" / "communications" aliases are the "Default" entry. */
function useDevices(on: boolean): MediaDeviceInfo[] {
  const [list, setList] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!on || !navigator.mediaDevices?.enumerateDevices) return;
    let live = true;
    const load = () => void navigator.mediaDevices.enumerateDevices().then((d) => {
      if (live) setList(d.filter((x) => x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications'));
    }, () => undefined);
    load();
    navigator.mediaDevices.addEventListener?.('devicechange', load);
    return () => { live = false; navigator.mediaDevices.removeEventListener?.('devicechange', load); };
  }, [on]);
  return list;
}

/** Can call audio be sent to a chosen output here (Chrome/Edge/Firefox desktop)? */
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** The Android app routes call audio itself (loudspeaker / earpiece). */
export function appRoutesAudio(): boolean {
  return isNative() && nativePlatform() === 'android';
}

export function CallDevices({ s, open, onClose }: { s: CallSnapshot; open: boolean; onClose: () => void }) {
  const t = useT();
  const list = useDevices(open);
  const [failed, setFailed] = useState(false);
  const close = () => { setFailed(false); onClose(); };
  const by = (kind: MediaDeviceKind) => list.filter((d) => d.kind === kind);
  const mics = by('audioinput');
  const cams = by('videoinput');
  const outs = by('audiooutput');
  const phone = typeof navigator !== 'undefined' && isMobileUa(navigator.userAgent);
  const route = appRoutesAudio();
  const sink = !route && canPickSpeaker() && outs.length > 1;
  const current = (id: string, ds: MediaDeviceInfo[]) => (ds.some((d) => d.deviceId === id) ? id : '');
  const done = (p: Promise<boolean>) => { setFailed(false); void p.then((ok) => { if (!ok) setFailed(true); }); };
  const nothing = mics.length < 2 && cams.length < 2 && !sink && !route;

  return (
    <Dialog open={open} onClose={close} title={t('calls.devices.title')} sheet className="k-call-devices"
      footer={<Button variant="primary" onClick={close}>{t('common.done')}</Button>}>
      <div className="k-stack">
        {failed ? <p className="k-call-check-err" role="alert"><Icon name="alert" /> {t('calls.devices.failed')}</p> : null}
        <DeviceSelect label={t('calls.check.mic')} value={current(s.micId, mics)} devices={mics} onChange={(id) => done(calls.setMic(id))} />
        {cams.length > 1 ? (
          phone ? (
            <div className="k-field">
              <span className="k-label">{t('calls.check.cam')}</span>
              <Segmented label={t('calls.check.cam')} block value={s.facing} onChange={(facing) => done(calls.setCamera({ facing }))} options={[
                { value: 'user', label: t('calls.devices.front') },
                { value: 'environment', label: t('calls.devices.back') },
              ]} />
            </div>
          ) : <DeviceSelect label={t('calls.check.cam')} value={current(s.camId, cams)} devices={cams} onChange={(id) => done(calls.setCamera({ id }))} />
        ) : null}
        {cams.length > 1 && !s.cam ? <p className="k-small k-muted">{t('calls.devices.camOff')}</p> : null}
        {sink ? <DeviceSelect label={t('calls.check.out')} value={current(s.sinkId, outs)} devices={outs} onChange={(id) => calls.setSink(id)} /> : null}
        {route ? (
          <div className="k-field">
            <span className="k-label">{t('calls.check.out')}</span>
            <Segmented label={t('calls.check.out')} block value={s.route} onChange={(r) => calls.setRoute(r)} options={[
              { value: 'speaker', label: t('calls.devices.loudspeaker') },
              { value: 'earpiece', label: t('calls.devices.earpiece') },
            ]} />
          </div>
        ) : null}
        {nothing ? <p className="k-small k-muted">{t('calls.devices.none')}</p> : <p className="k-small k-muted">{t('calls.devices.kept')}</p>}
      </div>
    </Dialog>
  );
}
