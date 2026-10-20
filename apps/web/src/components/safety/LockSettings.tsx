'use client';
// Safety centre → App lock: app PIN, auto-lock, wrong-PIN wipe, duress PIN and quick exit.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '@/i18n';
import {
  NEUTRAL_SITES, PinError, changeAppPin, configureDuress, disableAppLock, enableAppLock, pinSettings, setExitPrefs,
  setLockPrefs, setWipeAfter, useAppLock, useExitPrefs, useLockPrefs, type LockPrefs,
} from '@/lib/safety/applock';
import { duressSetHere, noteDuressHere, useHiddenChatIds } from '@/lib/safety/hidden';
import { PIN_MAX, PIN_MIN } from '@/lib/safety/pin';
import type { DuressAction } from '@/lib/keys/device';
import { Section } from '@/components/settings/shared';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Segmented } from '@/components/ui/Segmented';
import { Switch } from '@/components/ui/Switch';
import { TextField } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { SafetyPage } from './SafetyCentre';
import { PinDialog } from './PinDialog';

type T = (k: MessageKey, v?: Record<string, string | number>) => string;

function pinErrorText(t: T, e: unknown): string {
  const code = e instanceof PinError ? e.code : '';
  switch (code) {
    case 'pin_short': return t('safety.pin.short', { min: PIN_MIN });
    case 'pin_long': return t('safety.pin.long', { max: PIN_MAX });
    case 'pin_digits': return t('safety.pin.digits');
    case 'pin_simple': return t('safety.pin.simple');
    case 'pin_same_as_app_pin': return t('safety.duress.sameAsPin');
    case 'pin_same_as_duress': return t('safety.pin.sameAsDuress');
    case 'pin_wrong': return t('safety.lock.wrong');
    case 'pin_wait': return t('safety.lock.wait');
    default: return t('errors.unknown');
  }
}

/** Two masked numeric fields: new PIN + confirm. */
function NewPinFields({ pin, confirm, onPin, onConfirm, error, labels }: {
  pin: string; confirm: string; onPin: (v: string) => void; onConfirm: (v: string) => void; error?: string | null;
  labels: { pin: string; confirm: string };
}) {
  const t = useT();
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);
  return (
    <div className="k-safety-pinfields">
      <TextField label={labels.pin} type="password" inputMode="numeric" autoComplete="off" value={pin} maxLength={PIN_MAX}
        hint={t('safety.pin.hint', { min: PIN_MIN })} onChange={(e) => onPin(digits(e.target.value))} />
      <TextField label={labels.confirm} type="password" inputMode="numeric" autoComplete="off" value={confirm} maxLength={PIN_MAX}
        error={error ?? undefined} onChange={(e) => onConfirm(digits(e.target.value))} />
    </div>
  );
}

const WIPE_OPTIONS = ['never', '5', '10', '15'] as const;
type WipeOpt = (typeof WIPE_OPTIONS)[number];

// ---------------------------------------------------------------------------------------------- app PIN

function AppPinSection() {
  const t = useT();
  const toast = useToast();
  const { pin: state } = useAppLock();
  const hidden = useHiddenChatIds();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [wipe, setWipe] = useState<WipeOpt>('never');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'change' | 'change-pin' | 'off' | null>(null);
  const [nextPin, setNextPin] = useState('');
  const [nextConfirm, setNextConfirm] = useState('');
  const [nextErr, setNextErr] = useState<string | null>(null);

  async function enable(e: FormEvent) {
    e.preventDefault();
    if (pin !== confirm) { setErr(t('safety.pin.mismatch')); return; }
    setBusy(true); setErr(null);
    try {
      await enableAppLock(pin, { wipeAfter: wipe === 'never' ? null : Number(wipe) });
      setPin(''); setConfirm('');
      toast({ message: t('safety.pin.enabled') });
    } catch (e2) { setErr(pinErrorText(t, e2)); } finally { setBusy(false); }
  }

  if (state !== 'set') {
    return (
      <Section id="app-pin" title={t('safety.pin.title')} description={t('safety.pin.body')}>
        <form className="k-stack" onSubmit={enable}>
          <NewPinFields pin={pin} confirm={confirm} onPin={setPin} onConfirm={setConfirm} error={err}
            labels={{ pin: t('safety.pin.new'), confirm: t('safety.pin.confirm') }} />
          <Segmented label={t('safety.wipeAfter.title')} value={wipe} onChange={setWipe}
            options={WIPE_OPTIONS.map((o) => ({ value: o, label: o === 'never' ? t('safety.wipeAfter.never') : t('safety.wipeAfter.n', { count: Number(o) }) }))} />
          <p className="k-hint">{t('safety.wipeAfter.hint')}</p>
          <div><Button type="submit" variant="primary" icon="lock" busy={busy} disabled={!pin || !confirm}>{t('safety.pin.enable')}</Button></div>
        </form>
      </Section>
    );
  }

  return (
    <Section id="app-pin" title={t('safety.pin.title')} description={t('safety.pin.onBody')}>
      <div className="k-row-wrap">
        <Badge tone="success">{t('safety.on')}</Badge>
        <Button variant="secondary" onClick={() => { setDialog('change'); setNextPin(''); setNextConfirm(''); setNextErr(null); }}>{t('safety.pin.change')}</Button>
        <Button variant="ghost" onClick={() => setDialog('off')} disabled={hidden.size > 0}>{t('safety.pin.turnOff')}</Button>
      </div>
      {hidden.size > 0 ? <p className="k-hint">{t('safety.pin.offHidden')}</p> : null}
      {dialog === 'change' || dialog === 'change-pin' ? (
        <form className="k-stack" onSubmit={(e) => {
          e.preventDefault();
          if (nextPin !== nextConfirm) { setNextErr(t('safety.pin.mismatch')); return; }
          setNextErr(null); setDialog('change-pin');
        }}>
          <NewPinFields pin={nextPin} confirm={nextConfirm} onPin={setNextPin} onConfirm={setNextConfirm} error={nextErr}
            labels={{ pin: t('safety.pin.new'), confirm: t('safety.pin.confirm') }} />
          <div className="k-row-wrap">
            <Button type="submit" variant="primary" disabled={!nextPin || !nextConfirm}>{t('common.continue')}</Button>
            <Button variant="ghost" onClick={() => setDialog(null)}>{t('safety.cancel')}</Button>
          </div>
        </form>
      ) : null}
      <PinDialog
        open={dialog === 'off' || dialog === 'change-pin'}
        title={t('safety.pin.current')}
        body={dialog === 'off' ? t('safety.pin.offBody') : t('safety.pin.changeBody')}
        submitLabel={dialog === 'off' ? t('safety.pin.turnOff') : t('safety.pin.change')}
        onClose={() => { setDialog((d) => (d === 'change-pin' || d === 'change' ? 'change' : null)); }}
        onPin={async (current) => {
          try {
            if (dialog === 'off') { await disableAppLock(current); toast({ message: t('safety.pin.disabled') }); }
            else { await changeAppPin(current, nextPin); toast({ message: t('safety.pin.changed') }); setNextPin(''); setNextConfirm(''); }
            setDialog(null);
            return null;
          } catch (e) {
            const code = e instanceof PinError ? e.code : '';
            if (dialog === 'change-pin' && code !== 'pin_wrong' && code !== 'pin_wait') { setNextErr(pinErrorText(t, e)); setNextPin(''); setNextConfirm(''); setDialog('change'); return null; }
            return pinErrorText(t, e);
          }
        }} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- auto-lock

const IDLE: LockPrefs['idleMinutes'][] = [0, 1, 5, 15, 60];

function AutoLockSection() {
  const t = useT();
  const prefs = useLockPrefs();
  const { pin } = useAppLock();
  const [wipe, setWipeState] = useState<WipeOpt | null>(null);
  useEffect(() => {
    if (pin !== 'set') return;
    let live = true;
    void pinSettings().then((s) => { if (live && s) setWipeState(s.wipeAfter ? (String(s.wipeAfter) as WipeOpt) : 'never'); });
    return () => { live = false; };
  }, [pin]);
  return (
    <Section id="auto-lock" title={t('safety.autoLock.title')} description={pin === 'set' ? t('safety.autoLock.body') : t('safety.autoLock.bodyNoPin')}>
      <Segmented label={t('safety.autoLock.idle')} value={String(prefs.idleMinutes)} onChange={(v) => setLockPrefs({ ...prefs, idleMinutes: Number(v) as LockPrefs['idleMinutes'] })}
        options={IDLE.map((m) => ({ value: String(m), label: m === 0 ? t('safety.autoLock.never') : t('safety.autoLock.minutes', { count: m }) }))} />
      <Switch checked={prefs.onHide} onChange={(v) => setLockPrefs({ ...prefs, onHide: v })} label={t('safety.autoLock.onHide')} description={t('safety.autoLock.onHideHint')} />
      {pin === 'set' && wipe ? (
        <div className="k-stack-sm">
          <span className="k-label">{t('safety.wipeAfter.title')}</span>
          <Segmented label={t('safety.wipeAfter.title')} value={wipe} onChange={(v) => { setWipeState(v); void setWipeAfter(v === 'never' ? null : Number(v)); }}
            options={WIPE_OPTIONS.map((o) => ({ value: o, label: o === 'never' ? t('safety.wipeAfter.never') : t('safety.wipeAfter.n', { count: Number(o) }) }))} />
          <p className="k-hint">{t('safety.wipeAfter.hint')}</p>
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- duress

function DuressSection() {
  const t = useT();
  const toast = useToast();
  const { pin: state } = useAppLock();
  const [loaded, setLoaded] = useState<{ salt: string; set: boolean; action: DuressAction; name: string } | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [action, setAction] = useState<DuressAction>('none');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const s = await pinSettings();
    if (!s) { setLoaded(null); return; }
    const set = await duressSetHere(s.salt);
    setLoaded({ salt: s.salt, set, action: s.duressAction, name: s.decoyName });
    setAction(s.duressAction); setName(s.decoyName);
  }, []);
  useEffect(() => { if (state === 'set') void load(); }, [state, load]);

  if (state !== 'set') {
    return (
      <Section id="duress" title={t('safety.duress.title')} description={t('safety.duress.body')}>
        <Callout tone="info">{t('safety.duress.needsPin')}</Callout>
      </Section>
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!loaded) return;
    if (pin && pin !== confirm) { setErr(t('safety.pin.mismatch')); return; }
    setBusy(true); setErr(null);
    try {
      await configureDuress({ duressPin: pin ? pin : undefined, action, decoyName: name });
      if (pin) await noteDuressHere(loaded.salt, true);
      setPin(''); setConfirm('');
      toast({ message: t('safety.duress.saved') });
      await load();
    } catch (e2) { setErr(pinErrorText(t, e2)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!loaded) return;
    setBusy(true);
    try {
      await configureDuress({ duressPin: null, action: 'none' });
      await noteDuressHere(loaded.salt, false);
      toast({ message: t('safety.duress.removed') });
      await load();
    } finally { setBusy(false); }
  }

  return (
    <Section id="duress" title={t('safety.duress.title')} description={t('safety.duress.body')}>
      {loaded?.set ? <div><Badge tone="success">{t('safety.duress.isSet')}</Badge></div> : null}
      <form className="k-stack" onSubmit={save}>
        <NewPinFields pin={pin} confirm={confirm} onPin={setPin} onConfirm={setConfirm} error={err}
          labels={{ pin: loaded?.set ? t('safety.duress.newPin') : t('safety.duress.pin'), confirm: t('safety.pin.confirm') }} />
        <div className="k-stack-sm">
          <span className="k-label" id="duress-action-l">{t('safety.duress.action')}</span>
          <Segmented label={t('safety.duress.action')} value={action} onChange={setAction} block
            options={[{ value: 'none', label: t('safety.duress.actionNone') }, { value: 'wipe', label: t('safety.duress.actionWipe') }]} />
          <p className="k-hint">{action === 'wipe' ? t('safety.duress.actionWipeHint') : t('safety.duress.actionNoneHint')}</p>
        </div>
        <TextField label={t('safety.duress.decoyName')} hint={t('safety.duress.decoyNameHint')} value={name} maxLength={60}
          onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <div className="k-row-wrap">
          <Button type="submit" variant="primary" busy={busy} disabled={!loaded || (!loaded.set && !pin)}>{t('safety.save')}</Button>
          {loaded?.set ? <Button variant="ghost" onClick={() => void remove()} disabled={busy}>{t('safety.duress.remove')}</Button> : null}
        </div>
      </form>
      <Callout tone="warning">{t('safety.duress.limits')}</Callout>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- quick exit

const SITE_LABEL: Record<string, MessageKey> = {
  [NEUTRAL_SITES[0]]: 'safety.exit.siteWiki',
  [NEUTRAL_SITES[1]]: 'safety.exit.siteWeather',
  [NEUTRAL_SITES[2]]: 'safety.exit.siteSearch',
};

function QuickExitSection() {
  const t = useT();
  const p = useExitPrefs();
  return (
    <Section id="quick-exit" title={t('safety.exit.title')} description={t('safety.exit.body')}>
      <Switch checked={p.enabled} onChange={(v) => setExitPrefs({ ...p, enabled: v })} label={t('safety.exit.enable')} />
      {p.enabled ? (
        <>
          <Switch checked={p.button} onChange={(v) => setExitPrefs({ ...p, button: v })} label={t('safety.exit.showButton')} description={t('safety.exit.showButtonHint')} />
          <Switch checked={p.tripleTap} onChange={(v) => setExitPrefs({ ...p, tripleTap: v })} label={t('safety.exit.tripleTap')} description={t('safety.exit.tripleTapHint')} />
          <div className="k-stack-sm">
            <span className="k-label">{t('safety.exit.action')}</span>
            <Segmented label={t('safety.exit.action')} value={p.action} onChange={(v) => setExitPrefs({ ...p, action: v })} block
              options={[{ value: 'wipe', label: t('safety.exit.actionWipe') }, { value: 'lock', label: t('safety.exit.actionLock') }]} />
          </div>
          <div className="k-stack-sm">
            <span className="k-label">{t('safety.exit.site')}</span>
            <Segmented label={t('safety.exit.site')} value={p.site} onChange={(v) => setExitPrefs({ ...p, site: v })} block
              options={NEUTRAL_SITES.map((s) => ({ value: s, label: t(SITE_LABEL[s]!) }))} />
          </div>
          <p className="k-hint">{t('safety.exit.limits')}</p>
        </>
      ) : null}
    </Section>
  );
}

export function LockSettings() {
  const t = useT();
  return (
    <SafetyPage title={t('safety.lock.section')} description={t('safety.lock.pageBody')}>
      <AppPinSection />
      <AutoLockSection />
      <DuressSection />
      <QuickExitSection />
    </SafetyPage>
  );
}
