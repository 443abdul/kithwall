'use client';
// "Key log checked" on the verify screen (docs/v2/09-key-transparency.md): every time the screen opens, the
// contact's current identity key is looked up in Kithwall's public key log and the proof is checked against
// a tree head this device verified. Failures also show as the safety-number warning above (KeyChangeBanner).
import Link from 'next/link';
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useKeyLog } from '@/lib/kt/client';

export function KeyLogState({ userId, keys, name }: { userId: string; keys: { sign_pub: string; kx_pub: string } | null; name: string }) {
  const t = useT();
  const log = useKeyLog(userId, keys, { force: true });
  switch (log.state) {
    case 'idle':
    case 'checking':
      return <p className="k-keylog k-small k-muted" role="status"><Spinner size={14} /><span>{t('kt.checking')}</span></p>;
    case 'ok':
      return (
        <p className="k-keylog k-keylog-ok k-small" role="status" data-testid="key-log-checked">
          <Icon name="check" />
          <span>
            <strong>{t('kt.checked')}</strong>{' '}
            {log.index !== undefined && log.size ? t('kt.checkedBody', { name, entry: log.index + 1, size: log.size }) : t('kt.checkedShort', { name })}
          </span>
        </p>
      );
    case 'accepted':
      return <p className="k-keylog k-small k-muted"><Icon name="info" /><span>{t('kt.acceptedState', { name })}</span></p>;
    case 'missing':
    case 'bad':
      return <p className="k-keylog k-keylog-bad k-small" role="status"><Icon name="alert" /><span>{t('kt.failedState')}</span></p>;
    case 'hidden':
      return <p className="k-keylog k-small k-muted"><Icon name="info" /><span>{t('kt.hiddenState', { name })}</span></p>;
    case 'alarm':
      return (
        <p className="k-keylog k-keylog-bad k-small" role="alert">
          <Icon name="alert" />
          <span>{t('kt.alarmState')} <Link href="/transparency#key-log">{t('kt.alarmMore')}</Link></span>
        </p>
      );
    default:
      return <p className="k-keylog k-small k-muted"><Icon name="info" /><span>{t('kt.unavailableState')}</span></p>;
  }
}
