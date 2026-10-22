'use client';
// Step-by-step install instructions per platform (lib/install.ts). Plain text and two tiny inline SVG glyphs:
// renders on the server, so the landing page's "every device" list works without JavaScript.
import { useT, type MessageKey } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { InstallGroup, InstallPlatform } from '@/lib/install';

/** Safari's Share glyph (a box with an arrow out of it), so people can spot the button. */
function ShareGlyph() {
  return (
    <svg className="k-icon k-install-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M12 3.5v11M8 7.5l4-4 4 4" /><path d="M8.5 10.5H6.5v10h11v-10h-2" />
    </svg>
  );
}

const IOS: MessageKey[] = ['install.ios.safari', 'install.ios.share', 'install.ios.add', 'install.ios.open'];
const ANDROID: [InstallPlatform, MessageKey][] = [
  ['android-chromium', 'install.android.chromium'],
  ['android-samsung', 'install.android.samsung'],
  ['android-firefox', 'install.android.firefox'],
];
const DESKTOP: [InstallPlatform, MessageKey][] = [
  ['desktop-chromium', 'install.desktop.chromium'],
  ['desktop-safari', 'install.desktop.safari'],
  ['desktop-firefox', 'install.desktop.firefox'],
];

export const GROUPS: { group: InstallGroup; icon: IconName; title: MessageKey }[] = [
  { group: 'ios', icon: 'phone', title: 'install.group.ios' },
  { group: 'android', icon: 'phone', title: 'install.group.android' },
  { group: 'desktop', icon: 'monitor', title: 'install.group.desktop' },
];

function IosSteps() {
  const t = useT();
  return (
    <ol className="k-install-steps">
      {IOS.map((k) => (
        <li key={k}>{t(k)}{k === 'install.ios.share' ? <> <ShareGlyph /></> : null}</li>
      ))}
    </ol>
  );
}

/** The steps for one group of devices (the landing page's and settings' "every device" list). */
export function GroupSteps({ group }: { group: InstallGroup }) {
  const t = useT();
  if (group === 'ios') return <IosSteps />;
  const rows = group === 'android' ? ANDROID : DESKTOP;
  return (
    <ul className="k-install-browsers">
      {rows.map(([, k]) => <li key={k}>{t(k)}</li>)}
    </ul>
  );
}

/** The steps for exactly this browser. */
export function PlatformSteps({ platform }: { platform: InstallPlatform }) {
  const t = useT();
  if (platform === 'ios-safari') return <IosSteps />;
  if (platform === 'ios-other') {
    return (
      <div className="k-stack-sm">
        <p className="k-install-note"><Icon name="info" /> <span>{t('install.ios.other')}</span></p>
        <IosSteps />
      </div>
    );
  }
  const row = [...ANDROID, ...DESKTOP].find(([p]) => p === platform);
  return <p className="k-install-one">{t(row ? row[1] : 'install.manual')}</p>;
}

/** Collapsible steps for every kind of device. */
export function AllDevices({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const t = useT();
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="k-install-all">
      <H className="k-install-all-title">{t('install.allDevices')}</H>
      {GROUPS.map((g) => (
        <details key={g.group} className="k-install-details">
          <summary>
            <span className="k-install-sum-ico" aria-hidden><Icon name={g.icon} /></span>
            <span className="k-install-sum-text">{t(g.title)}</span>
            <Icon name="down" />
          </summary>
          <div className="k-install-details-body"><GroupSteps group={g.group} /></div>
        </details>
      ))}
    </div>
  );
}
