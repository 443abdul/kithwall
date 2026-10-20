'use client';
// Verify a contact (/u/[handle]/verify): the 60-digit safety number made from both people's identity
// keys (packages/crypto safety.ts), as twelve groups of five and as a QR code. Two people compare it
// in person or on a call they trust: scan each other's code, or read the digits aloud / paste them.
// "Verified" is stored only in my encrypted vault (lib/transparency/verified.ts).
import { useQuery } from '@tanstack/react-query';
import { b64u, formatSafetyNumber, parseSafetyQr, safetyNumber, safetyNumbersMatch, safetyQrPayload } from '@kithwall/crypto';
import { useEffect, useMemo, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Textarea } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { Page, useMe } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { normalizeHandle } from '@/components/people/data';
import { useSession } from '@/lib/keys/session';
import { encodeQr, qrPath } from '@/lib/qr';
import { useFileUrl } from '@/lib/media';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { clearVerified, markVerified, useRefreshIdentityKey, useSafetyNumber, useVerified } from '@/lib/transparency/verified';
import { KeyChangeBanner } from './KeyChangeBanner';
import { canScanQr, QrScanner } from './QrScanner';

export function VerifyScreen({ handle }: { handle: string }) {
  const t = useT();
  const { status } = useSession();
  const h = normalizeHandle(decodeURIComponent(handle));
  const q = useQuery({ queryKey: ['profile-by-handle', h], enabled: status === 'ready', queryFn: async () => (await people.byUsername(h)) ?? null });
  useDocumentTitle(t('verify.title'));
  const back = { href: `/u/${encodeURIComponent(h)}`, label: t('common.back') };
  if (q.isPending) return <Page title={t('verify.title')} back={back}><div className="k-center"><Spinner size={28} /></div></Page>;
  if (!q.data) {
    return (
      <Page title={t('verify.title')} back={{ href: '/people', label: t('common.back') }}>
        <Card><EmptyState icon="search" title={t('profile.notFoundTitle')} body={t('profile.notFoundBody')} /></Card>
      </Page>
    );
  }
  return <Verify id={q.data.id} handle={q.data.username} back={back} />;
}

type Compare = { kind: 'match' | 'mismatch' | 'notKithwall'; via: 'qr' | 'digits' } | null;

function Verify({ id, handle, back }: { id: string; handle: string; back: { href: string; label: string } }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const me = useMe();
  const { userId } = useSession();
  usePeopleVersion();
  const person = usePerson(id);
  const theirAvatar = useFileUrl(person?.info?.avatar?.thumb);
  const name = person?.name ?? `@${handle}`;
  const sn = useSafetyNumber(id);
  const v = useVerified(id);
  const refreshKey = useRefreshIdentityKey();
  const [scanOk, setScanOk] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<Compare>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; void canScanQr().then((ok) => { if (on) setScanOk(ok); }); return () => { on = false; }; }, []);

  const groups = useMemo(() => (sn.number ? formatSafetyNumber(sn.number) : []), [sn.number]);
  const qr = useMemo(() => (sn.number ? encodeQr(safetyQrPayload(sn.number), 'M') : null), [sn.number]);

  if (id === userId) {
    return (
      <Page title={t('verify.title')} back={back}>
        <Card><EmptyState icon="shield" title={t('verify.selfTitle')} body={t('verify.selfBody')} /></Card>
      </Page>
    );
  }

  /** Re-read their key and recompute before saving, so I never mark a key I didn't just compare. */
  async function verify(via: 'qr' | 'digits') {
    setBusy(true); setErr(null);
    try {
      const fresh = await refreshKey(id);
      const mine = me.userId ? await refreshKey(me.userId) : null;
      if (!fresh || !mine || !me.userId) throw new Error('missing');
      const now = safetyNumber({ userId: me.userId, signPub: b64u.decode(mine.sign_pub) }, { userId: id, signPub: b64u.decode(fresh.sign_pub) });
      if (now !== sn.number) { setErr(t('verify.keyMoved')); return; }
      await markVerified(id, fresh.sign_pub, via);
      toast({ message: t('verify.markedToast', { name }) });
    } catch {
      setErr(t('verify.saveFailed'));
    } finally { setBusy(false); }
  }

  function onScan(text: string) {
    setScanning(false);
    const n = parseSafetyQr(text);
    if (!n) { setResult({ kind: 'notKithwall', via: 'qr' }); return; }
    const ok = n === sn.number;
    setResult({ kind: ok ? 'match' : 'mismatch', via: 'qr' });
    if (ok && v.status !== 'verified') void verify('qr');
  }

  function onCompare() {
    if (!sn.number) return;
    setResult({ kind: safetyNumbersMatch(sn.number, typed) ? 'match' : 'mismatch', via: 'digits' });
  }

  return (
    <Page title={t('verify.title')} description={t('verify.lede', { name })} back={back}>
      <KeyChangeBanner userId={id} name={name} handle={handle} showVerifyLink={false} />
      <Card className="k-verify-card">
        <div className="k-verify-people" aria-hidden="true">
          <Avatar name={me.name || '?'} src={me.avatar} size={48} />
          <Icon name="lock" />
          <Avatar name={name} src={theirAvatar} size={48} />
        </div>
        <h2 className="k-section-title k-center">{t('verify.numberTitle', { name })}</h2>
        {sn.loading || !sn.number ? <div className="k-center"><Spinner /></div> : (
          <>
            <ol className="k-safety-number k-ltr" role="list" aria-label={t('verify.numberLabel')}>
              {groups.map((g, i) => <li key={i}>{g}</li>)}
            </ol>
            {qr ? (
              <figure className="k-verify-qr">
                <svg className="k-qr" viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`} width={208} height={208} role="img" aria-label={t('verify.qrLabel')} shapeRendering="crispEdges">
                  <rect className="k-qr-bg" width={qr.size + 8} height={qr.size + 8} />
                  <path className="k-qr-fg" d={qrPath(qr, 4)} />
                </svg>
                <figcaption className="k-small k-muted">{t('verify.qrCaption', { name })}</figcaption>
              </figure>
            ) : null}
          </>
        )}
        <VerifiedState status={v.status} at={v.verifiedAt} name={name} />
        {err ? <Callout tone="danger">{err}</Callout> : null}
        {result ? <ResultCallout r={result} name={name} /> : null}
        <div className="k-row-wrap k-verify-actions">
          {scanOk ? (
            <Button variant={scanning ? 'secondary' : 'primary'} icon="camera" onClick={() => { setResult(null); setScanning((s) => !s); }}>
              {scanning ? t('verify.stopScan') : t('verify.scan')}
            </Button>
          ) : null}
          {v.status === 'verified' ? (
            <Button variant="ghost" busy={busy} onClick={() => { setBusy(true); void clearVerified(id).finally(() => setBusy(false)); }}>{t('verify.clear')}</Button>
          ) : (
            <Button variant={scanOk ? 'secondary' : 'primary'} icon="shield" busy={busy} disabled={!sn.number} onClick={() => void verify(result?.kind === 'match' ? result.via : 'digits')}>
              {t('verify.mark')}
            </Button>
          )}
        </div>
        {scanning ? <QrScanner label={t('verify.scannerLabel', { name })} onResult={onScan} /> : null}
        {!scanOk ? <p className="k-small k-muted">{t('verify.noCamera')}</p> : null}
      </Card>

      <Card>
        <div className="k-stack">
          <h2 className="k-section-title">{t('verify.compareTitle')}</h2>
          <p className="k-small k-muted">{t('verify.compareBody', { name })}</p>
          <Textarea label={t('verify.pasteLabel')} value={typed} rows={3} dir="ltr" inputMode="numeric" autoComplete="off" spellCheck={false}
            onChange={(e) => { setTyped(e.target.value); if (result?.via === 'digits') setResult(null); }} />
          <div><Button variant="secondary" disabled={!typed.trim() || !sn.number} onClick={onCompare}>{t('verify.compare')}</Button></div>
        </div>
      </Card>

      <Card>
        <div className="k-stack-sm">
          <h2 className="k-section-title">{t('verify.whatTitle')}</h2>
          <p className="k-small">{t('verify.what1', { name })}</p>
          <p className="k-small">{t('verify.what2')}</p>
          <p className="k-small k-muted">{t('verify.what3')}</p>
        </div>
      </Card>
      {sn.theirKey && v.verifiedAt && v.status === 'verified' ? (
        <p className="k-xs k-muted k-center">{t('verify.storedNote', { date: f.date(new Date(v.verifiedAt)) })}</p>
      ) : null}
    </Page>
  );
}

function VerifiedState({ status, at, name }: { status: string; at: string | null; name: string }) {
  const t = useT();
  const f = useFormat();
  if (status === 'verified' && at) {
    return <Callout tone="success" icon="shield">{t('verify.isVerified', { name, date: f.date(new Date(at)) })}</Callout>;
  }
  if (status === 'none') return <p className="k-small k-muted k-center">{t('verify.notVerified', { name })}</p>;
  return null;
}

function ResultCallout({ r, name }: { r: NonNullable<Compare>; name: string }) {
  const t = useT();
  if (r.kind === 'match') return <Callout tone="success">{r.via === 'qr' ? t('verify.scanMatch', { name }) : t('verify.digitsMatch')}</Callout>;
  if (r.kind === 'notKithwall') return <Callout tone="warning">{t('verify.notKithwallCode')}</Callout>;
  return <Callout tone="danger">{r.via === 'qr' ? t('verify.scanMismatch', { name }) : t('verify.digitsMismatch')}</Callout>;
}
