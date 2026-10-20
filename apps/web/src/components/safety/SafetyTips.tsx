'use client';
// Safety centre → Tips: short, honest advice about the limits of what an app can do.
import { useT, type MessageKey } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SafetyPage } from './SafetyCentre';

const TIPS: { icon: IconName; title: MessageKey; body: MessageKey }[] = [
  { icon: 'fingerprint', title: 'safety.tips.passkeyTitle', body: 'safety.tips.passkeyBody' },
  { icon: 'eye', title: 'safety.tips.metadataTitle', body: 'safety.tips.metadataBody' },
  { icon: 'globe', title: 'safety.tips.torTitle', body: 'safety.tips.torBody' },
  { icon: 'camera', title: 'safety.tips.screenshotTitle', body: 'safety.tips.screenshotBody' },
  { icon: 'users', title: 'safety.tips.sharedTitle', body: 'safety.tips.sharedBody' },
  { icon: 'activity', title: 'safety.tips.notificationsTitle', body: 'safety.tips.notificationsBody' },
  { icon: 'key', title: 'safety.tips.recoveryTitle', body: 'safety.tips.recoveryBody' },
];

export function SafetyTips() {
  const t = useT();
  return (
    <SafetyPage title={t('safety.tips.title')} description={t('safety.tips.pageBody')}>
      <div className="k-safety-tips">
        {TIPS.map((x) => (
          <Card key={x.title} as="section">
            <div className="k-safety-tip">
              <span className="k-item-icon" aria-hidden><Icon name={x.icon} /></span>
              <div>
                <h2 className="k-safety-h">{t(x.title)}</h2>
                <p className="k-small">{t(x.body)}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </SafetyPage>
  );
}
