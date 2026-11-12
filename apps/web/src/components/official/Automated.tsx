'use client';
// How Kithwall's automated accounts are marked (docs/v2/13-official-accounts.md): a badge next to the name
// wherever the account appears.
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { useIsAutomated } from '@/lib/official/client';

/** "Automated", shown next to the name of an account that Kithwall runs. Nothing for everyone else. */
export function AutomatedBadge({ userId, chip }: { userId: string | null | undefined; chip?: boolean }) {
  const t = useT();
  if (!useIsAutomated(userId)) return null;
  return (
    <span className={chip ? 'k-chip k-auto' : 'k-aud k-auto'} title={t('official.badgeTitle')}>
      <Icon name="bolt" /><span className="k-aud-label">{t('official.badge')}</span>
    </span>
  );
}
