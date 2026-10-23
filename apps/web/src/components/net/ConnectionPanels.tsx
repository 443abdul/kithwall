'use client';
// Building blocks shared by Settings → Connection and the public "If Kithwall is blocked" help page
// (docs/v2/08-censorship.md): the current route, known mirrors (signed list), Tor and the Android app.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { QrCode } from '@/components/people/InviteCard';
import { NET } from '@/lib/net/config';
import { shareText, toToken } from '@/lib/net/mirrors';
import { acceptMirrorList, recheck } from '@/lib/net/runtime';
import { hasNativeNet, nativeNetStatus, openOrbot, setNativeTor, type NetNativeStatus } from '@/lib/net/native';
import { nativeErrorCode } from '@/lib/native';
import { REPO_URL } from '@/lib/source';
import { useNet } from './useNet';

const host = (o: string) => { try { return new URL(o).host; } catch { return o; } };
const noSub = () => () => undefined;
/** This page's origin ('' while server rendering, so hydration matches). */
const useHere = () => useSyncExternalStore(noSub, () => location.origin, () => '');

/** How this page reaches the backend right now, with a "Check now" button. */
export function RoutePanel() {
  const t = useT();
  const net = useNet();
  if (!net.enabled) return <p className="k-muted k-small">{t('net.route.notConfigured')}</p>;
  const r = net.current;
  const how = !r ? t('net.status.unknown')
    : r.kind === 'direct' ? t('net.route.direct')
      : r.kind === 'onion' ? t('net.route.onion')
        : r.kind === 'mirror' ? t('net.route.mirror', { host: host(r.appOrigin) })
          : t('net.route.proxy');
  const statusKey: MessageKey = `net.status.${net.status}`;
  return (
    <div className="k-stack">
      <p><strong>{how}</strong></p>
      <p className="k-muted k-small" role="status">{t(statusKey)}</p>
      <div>
        <Button size="sm" icon="refresh" busy={net.checking} busyLabel={t('net.checking')} onClick={() => void recheck()}>{t('net.check')}</Button>
      </div>
    </div>
  );
}

/** Mirrors known on this device (signed list + built-in), sharing, and adding a list someone sent. */
export function MirrorsPanel() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const net = useNet();
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');

  const mirrors = useMemo(() => {
    const fromList = (net.list?.mirrors ?? []).filter((m) => m.kind !== 'onion').map((m) => ({ origin: m.origin, label: m.label }));
    const known = new Set(fromList.map((m) => m.origin));
    return [...fromList, ...NET.mirrorOrigins.filter((o) => !known.has(o)).map((origin) => ({ origin, label: undefined as string | undefined }))];
  }, [net.list]);

  const here = useHere();
  const text = net.list ? shareText(net.list, net.signed, t('net.mirrors.shareIntro'))
    : mirrors.length ? [t('net.mirrors.shareIntro'), ...mirrors.map((m) => m.origin)].join('\n') : '';
  const token = net.signed ? toToken(net.signed) : '';

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast({ message: t('net.mirrors.copied') }); } catch { /* clipboard blocked */ }
  };
  const share = async () => {
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ text }); return; } catch { /* cancelled */ return; }
    }
    await copy();
  };
  const add = () => {
    const r = acceptMirrorList(paste);
    if (r.ok) { setPaste(''); setError(''); toast({ message: t('net.mirrors.added') }); return; }
    setError(t(`net.mirrors.invalid.${r.reason}` as MessageKey));
  };

  return (
    <div className="k-stack">
      {mirrors.length ? (
        <ul className="k-net-mirrors" role="list">
          {mirrors.map((m) => (
            <li key={m.origin}>
              <span className="k-net-mirror-host" dir="ltr">{host(m.origin)}</span>
              {m.label ? <span className="k-muted k-small">{m.label}</span> : null}
              {m.origin === here ? <span className="k-muted k-small">{t('net.mirrors.current')}</span>
                : <a className="k-btn k-btn-soft k-btn-sm" href={`${m.origin}/`} rel="noopener noreferrer">{t('net.mirrors.open')}</a>}
            </li>
          ))}
        </ul>
      ) : <p className="k-muted k-small">{t('net.mirrors.none')}</p>}
      {net.list ? (
        <p className="k-muted k-small">{t('net.mirrors.version', { version: net.list.version, date: f.date(Date.parse(net.list.expires)) })}</p>
      ) : null}
      {net.list?.note ? <p className="k-small" dir="auto">{net.list.note}</p> : null}
      <p className="k-muted k-small">{t('net.mirrors.signin')}</p>
      {text ? (
        <div className="k-net-share">
          {token && token.length <= 1800 ? <QrCode text={token} label={t('net.mirrors.qr')} size={176} /> : null}
          <div className="k-row-wrap">
            <Button size="sm" icon="share" onClick={() => void share()}>{t('net.mirrors.share')}</Button>
            <Button size="sm" variant="ghost" icon="copy" onClick={() => void copy()}>{t('net.mirrors.copy')}</Button>
          </div>
        </div>
      ) : null}
      {NET.mirrorListPubkey ? (
        <div className="k-stack">
          <Textarea label={t('net.mirrors.paste')} hint={t('net.mirrors.pasteHint')} rows={3} value={paste} dir="ltr"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            onChange={(e) => { setPaste(e.target.value); setError(''); }} error={error || undefined} />
          <div><Button size="sm" variant="secondary" disabled={!paste.trim()} onClick={add}>{t('net.mirrors.add')}</Button></div>
        </div>
      ) : null}
    </div>
  );
}

/** Tor: Tor Browser + onion address everywhere; in the Android app, "Use Tor (Orbot)". */
export function TorPanel() {
  const t = useT();
  const toast = useToast();
  const net = useNet();
  const onion = NET.onionOrigin || net.list?.mirrors.find((m) => m.kind === 'onion')?.origin || '';
  const [st, setSt] = useState<NetNativeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const native = hasNativeNet();
  useEffect(() => {
    if (!native) return;
    let live = true;
    const load = () => { void nativeNetStatus().then((s) => { if (live) setSt(s); }); };
    load();
    addEventListener('focus', load);
    return () => { live = false; removeEventListener('focus', load); };
  }, [native]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try { setSt(await setNativeTor(on)); } catch (e) {
      const code = nativeErrorCode(e);
      toast({ message: t(code === 'orbot_missing' ? 'net.tor.app.needOrbot' : code === 'unsupported' ? 'net.tor.app.unsupported' : 'net.tor.app.notRunning') });
    } finally { setBusy(false); }
  };

  return (
    <div className="k-stack">
      <p className="k-small">{t('net.tor.body')}</p>
      {native && st ? (
        <div className="k-stack">
          {st.proxySupported ? (
            <Switch checked={st.tor} disabled={busy || (!st.orbotInstalled && !st.tor)} onChange={(v) => void toggle(v)}
              label={t('net.tor.app.title')} description={t('net.tor.app.body')} />
          ) : <Callout tone="warning">{t('net.tor.app.unsupported')}</Callout>}
          {!st.orbotInstalled ? <Callout>{t('net.tor.app.needOrbot')}</Callout>
            : !st.orbotRunning ? <Callout tone="warning">{t('net.tor.app.notRunning')}</Callout>
              : st.tor ? <Callout tone="success">{t('net.tor.app.on')}</Callout> : null}
          <div><Button size="sm" variant="secondary" onClick={() => void openOrbot()}>{t(st.orbotInstalled ? 'net.tor.app.openOrbot' : 'net.tor.app.getOrbot')}</Button></div>
        </div>
      ) : (
        <p className="k-small">{t('net.tor.browser')}</p>
      )}
      {onion ? (
        <div className="k-stack">
          <p className="k-small">{t('net.tor.onion')}</p>
          <code className="k-net-onion" dir="ltr">{onion}</code>
        </div>
      ) : null}
      <p className="k-muted k-small">{t('net.tor.bridges')}</p>
    </div>
  );
}

/** Where to get the Android app when stores and the website are blocked, and how to check it. */
export function ApkPanel() {
  const t = useT();
  const net = useNet();
  const links = [...new Set([...(net.list?.apk.map((a) => a.url) ?? []), ...NET.apkUrls])];
  const cert = net.list?.apkCert || NET.apkCertSha256;
  return (
    <div className="k-stack">
      <p className="k-small">{t('net.apk.body')}</p>
      <ul className="k-net-links" role="list">
        {links.map((u) => <li key={u}><a href={u} rel="noopener noreferrer" dir="ltr">{host(u)}</a></li>)}
        <li><a href={`${REPO_URL}/releases`} rel="noopener noreferrer">{t('net.apk.github')}</a></li>
      </ul>
      {cert ? (
        <div className="k-stack">
          <p className="k-muted k-small">{t('net.apk.cert')}</p>
          <code className="k-net-onion" dir="ltr">{cert}</code>
        </div>
      ) : null}
    </div>
  );
}
