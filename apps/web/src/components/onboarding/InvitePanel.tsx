'use client';
// "Find your people": share an invite link or show a QR code. There is no contact upload (brief §5.4).
// Personal invite links and the real QR code arrive with Connections in phase 2; until then the link
// points at the sign-up page and the QR tile is a placeholder.
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';

export function InvitePanel() {
  const t = useT();
  const toast = useToast();
  const [link, setLink] = useState('');
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- origin is only known in the browser
    setLink(`${location.origin}/join`);
    setCanShare(typeof navigator.share === 'function');
  }, []);

  async function copy() {
    try { await navigator.clipboard.writeText(link); toast({ message: t('invite.copied') }); }
    catch { toast({ message: t('invite.copyFailed'), tone: 'danger' }); }
  }
  async function share() {
    try { await navigator.share({ title: 'Kithwall', text: t('invite.shareText'), url: link }); } catch { /* cancelled */ }
  }

  return (
    <div className="k-invite">
      <div className="k-invite-qr" aria-hidden><Icon name="qr" /></div>
      <div className="k-invite-body">
        <p className="k-label">{t('invite.linkLabel')}</p>
        <p className="k-invite-link k-ltr">{link || '…'}</p>
        <p className="k-small k-muted">{t('invite.soon')}</p>
        <div className="k-row-wrap">
          <Button size="sm" variant="soft" icon="copy" onClick={() => void copy()} disabled={!link}>{t('invite.copy')}</Button>
          {canShare ? <Button size="sm" variant="soft" icon="share" onClick={() => void share()}>{t('invite.share')}</Button> : null}
        </div>
      </div>
    </div>
  );
}
