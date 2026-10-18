'use client';
// Settings → Account: "Push Notifications" and "Install Kithwall" sections.
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/keys/session';
import {
  DEFAULT_PUSH_PREFS, disablePush, enablePush, installState, loadPushPrefs, promptInstall, pushEnabledHere,
  pushSupport, savePushPrefs, sendTestPush, usePushValue, usePushVersion, type PushPrefs,
} from '@/lib/push';

const msg = (x: unknown) => (x as Error).message;

const PREF_LABELS: [keyof PushPrefs, string][] = [
  ['messages', 'Messages'],
  ['activity', 'Comments, likes, tags and Wall posts'],
  ['friend_requests', 'Friend requests and confirmations'],
  ['pokes', 'Pokes'],
  ['invites', 'Group and event invites, join requests and game requests'],
  ['security', 'Account recovery and key-sharing requests (recommended)'],
];

export function PushSettingsSection() {
  const v = usePushVersion();
  const { userId } = useSession();
  const support = {
    supported: usePushValue(() => pushSupport().supported, false),
    iosNeedsInstall: usePushValue(() => pushSupport().iosNeedsInstall, false),
    permission: usePushValue(() => pushSupport().permission, 'unsupported'),
  };
  const [on, setOn] = useState<boolean | null>(null);
  const [prefs, setPrefs] = useState<PushPrefs>(DEFAULT_PUSH_PREFS);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    pushEnabledHere().then((x) => { if (live) setOn(x); }).catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, [v, userId]);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    loadPushPrefs(userId).then((p) => { if (live) setPrefs(p); }).catch(() => undefined);
    return () => { live = false; };
  }, [userId]);

  async function toggle(next: boolean) {
    if (!userId) return;
    setErr(null); setOk(null); setBusy('toggle');
    try {
      if (next) { await enablePush(userId); setOn(true); setOk('Push notifications are on for this device.'); }
      else { await disablePush(userId); setOn(false); setOk('Push notifications are off for this device.'); }
    } catch (x) { setErr(msg(x)); } finally { setBusy(null); }
  }

  async function setPref(k: keyof PushPrefs, val: boolean) {
    if (!userId) return;
    const next = { ...prefs, [k]: val };
    setPrefs(next); setErr(null); setOk(null);
    try { await savePushPrefs(userId, next); setOk('Saved.'); } catch (x) { setPrefs(prefs); setErr(msg(x)); }
  }

  async function test() {
    setErr(null); setOk(null); setBusy('test');
    try { await sendTestPush(); setOk('Test notification sent. It should appear in a few seconds.'); }
    catch (x) { setErr(msg(x)); } finally { setBusy(null); }
  }

  let status: ReactNode = null;
  if (support.iosNeedsInstall) {
    status = <p className="kw-help" style={{ marginBottom: 6 }}>On iPhone and iPad, notifications only work in the installed app (iOS 16.4 or later).
      Add Kithwall to your Home Screen (see <a href="#install">Install Kithwall</a> below), open it from there, and turn notifications on in its Settings.</p>;
  } else if (!support.supported) {
    status = <p className="kw-help" style={{ marginBottom: 6 }}>This browser doesn&rsquo;t support push notifications. Try a recent Chrome, Edge, Firefox or Safari.</p>;
  } else if (support.permission === 'denied') {
    status = <p className="kw-help" style={{ marginBottom: 6 }}>Notifications are blocked for Kithwall in this browser. Allow them in your browser&rsquo;s site settings, then come back here.</p>;
  }

  return (
    <div className="isec" id="push">
      <h3>Push Notifications</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok" role="status">{ok}</div>}
      <p style={{ lineHeight: '16px', marginBottom: 6 }}>
        Browsers can&rsquo;t keep a closed website running, so push notifications are how Kithwall reaches you when it isn&rsquo;t open.
        They say only <b>who did what</b> &mdash; &ldquo;dan sent you a message&rdquo;, &ldquo;jessica commented on your post&rdquo; &mdash;
        never what anyone wrote. They travel encrypted through your browser maker&rsquo;s push service (Google, Apple, Mozilla or Microsoft), which can&rsquo;t read them.
      </p>
      {status}
      <label className="kw-check">
        <input type="checkbox" checked={!!on} disabled={on === null || busy !== null || (!on && (!support.supported || support.iosNeedsInstall || support.permission === 'denied'))}
          onChange={(e) => void toggle(e.target.checked)} />{' '}
        <b>Push notifications on this device</b>{busy === 'toggle' ? <span className="gray"> &hellip;</span> : null}
      </label>
      <fieldset style={{ border: 0, padding: '4px 0 0 18px', margin: 0 }}>
        <legend className="gray" style={{ padding: 0, marginBottom: 2 }}>Push me about (applies to every device where push is on):</legend>
        {PREF_LABELS.map(([k, label]) => (
          <label className="kw-check" key={k}><input type="checkbox" checked={prefs[k]} onChange={(e) => void setPref(k, e.target.checked)} /> {label}</label>
        ))}
      </fieldset>
      <div className="kw-actions" style={{ marginTop: 6 }}>
        <button type="button" className="btn" disabled={!on || busy !== null} onClick={() => void test()}>{busy === 'test' ? 'Sending…' : 'Send a test notification'}</button>
      </div>
      <p className="kw-help" style={{ marginTop: 6 }}>Logging out stops notifications on this device. To stop them everywhere, turn this off on each device or block notifications for Kithwall in your browser.</p>
    </div>
  );
}

export function InstallSection() {
  const st = {
    canPrompt: usePushValue(() => installState().canPrompt, false),
    installed: usePushValue(() => installState().installed, false),
  };
  const ios = usePushValue(() => pushSupport().ios, false);
  const [note, setNote] = useState<string | null>(null);

  async function install() {
    setNote(null);
    const r = await promptInstall();
    if (r === 'accepted') setNote('Kithwall is installed. You can open it from your Home Screen or app list.');
  }

  return (
    <div className="isec" id="install">
      <h3>Install Kithwall</h3>
      <p style={{ lineHeight: '16px', marginBottom: 6 }}>Kithwall can be installed like an app: it opens in its own window, gets an icon on your Home Screen or desktop,
        and shows unread counts on that icon. It&rsquo;s the same site &mdash; nothing extra is downloaded or stored.</p>
      {note && <div className="ok" role="status">{note}</div>}
      {st.installed ? (
        <p className="gray">You&rsquo;re using the installed app.</p>
      ) : ios ? (
        <ol style={{ lineHeight: '18px', margin: '0 0 6px 18px', padding: 0 }}>
          <li>Open Kithwall in <b>Safari</b>.</li>
          <li>Tap the <b>Share</b> button (the square with an arrow pointing up).</li>
          <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li>Open Kithwall from your Home Screen, log in, and turn on <a href="#push">push notifications</a> there. (iPhone and iPad allow web notifications only for Home Screen apps, on iOS 16.4 or later.)</li>
        </ol>
      ) : st.canPrompt ? (
        <div className="kw-actions"><button type="button" className="btn b" onClick={() => void install()}>Install Kithwall</button></div>
      ) : (
        <p className="kw-help">If your browser supports it, look for <b>Install</b> or <b>Add to Home screen</b> in its menu (Chrome, Edge, Samsung Internet), or in Safari on a Mac choose <b>File &rarr; Add to Dock</b>.</p>
      )}
    </div>
  );
}
