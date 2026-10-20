import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

const ICONS: Record<string, IconName> = { info: 'info', danger: 'alert', success: 'check', warning: 'alert', accent: 'sparkle' };

/** Inline message box (form errors, notices). Errors use role="alert". */
export function Callout({ tone = 'info', icon, children }: { tone?: 'info' | 'danger' | 'success' | 'warning' | 'accent'; icon?: IconName; children: ReactNode }) {
  return (
    <div className={`k-callout${tone !== 'info' ? ` k-callout-${tone}` : ''}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? ICONS[tone]!} />
      <div>{children}</div>
    </div>
  );
}
