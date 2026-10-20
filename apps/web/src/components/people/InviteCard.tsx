'use client';
// Personal invite link + QR code. The QR code is drawn on this device (lib/qr.ts, no network); the link
// carries a random invite code (public.invites: 10 uses, 30 days). Whoever joins with it sends you a
// connection request.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { useSession } from '@/lib/keys/session';
import { encodeQr, qrPath } from '@/lib/qr';
import { currentInvite, inviteUrl, newInvite } from './data';

export function QrCode({ text, label, size = 168 }: { text: string; label: string; size?: number }) {
  const qr = useMemo(() => encodeQr(text, 'M'), [text]);
  const dim = qr.size + 8;
  return (
    <svg className="k-qr" viewBox={`0 0 ${dim} ${dim}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="k-qr-bg" width={dim} height={dim} />
      <path className="k-qr-fg" d={qrPath(qr, 4)} />
    </svg>
  );
}

export function InviteCard() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const { status } = useSession();
  const [origin, setOrigin] = useState('');
  const [canShare, setCanShare] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- only known in the browser
    setOrigin(location.origin);
    setCanShare(typeof navigator.share === 'function');
  }, []);
  const q = useQuery({ queryKey: ['my-invite'], enabled: status === 'ready', staleTime: 60_000, queryFn: currentInvite });
  const link = q.data && origin ? inviteUrl(origin, q.data.code) : '';

  async function copy() {
    try { await navigator.clipboard.writeText(link); toast({ message: t('people.copied') }); }
    catch { toast({ message: t('feed.failed'), tone: 'danger' }); }
  }
  async function share() {
    try { await navigator.share({ title: 'Kithwall', text: t('people.shareText'), url: link }); } catch { /* cancelled */ }
  }
  async function rotate() {
    setBusy(true);
    try { qc.setQueryData(['my-invite'], await newInvite()); }
    catch { toast({ message: t('people.inviteFailed'), tone: 'danger' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="k-invite2">
      <div className="k-invite2-qr">
        {link ? <QrCode text={link} label={t('people.qrLabel')} /> : q.isError ? null : <Spinner size={28} />}
      </div>
      <div className="k-invite2-body">
        <h3>{t('people.inviteTitle')}</h3>
        <p className="k-muted k-small">{t('people.inviteBody')}</p>
        {q.isError ? <p className="k-error" role="alert">{t('people.inviteFailed')}</p> : null}
        <p className="k-invite-link k-ltr">{link || '…'}</p>
        {q.data ? (
          <p className="k-muted k-xs">
            {t('people.inviteExpires', { date: f.date(new Date(q.data.expires_at), { dateStyle: 'medium' }) })}
            {q.data.uses ? <> · {t('people.inviteUsed', { count: q.data.uses })}</> : null}
          </p>
        ) : null}
        <div className="k-row-wrap">
          <Button size="sm" variant="primary" icon="copy" onClick={() => void copy()} disabled={!link}>{t('people.copy')}</Button>
          {canShare ? <Button size="sm" variant="soft" icon="share" onClick={() => void share()} disabled={!link}>{t('people.share')}</Button> : null}
          <Button size="sm" variant="ghost" icon="refresh" busy={busy} onClick={() => void rotate()}>{t('people.inviteNew')}</Button>
        </div>
      </div>
    </div>
  );
}
