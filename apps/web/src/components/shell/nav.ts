import type { IconName } from '@/components/ui/Icon';
import type { MessageKey } from '@/i18n';

export type NavKey = 'home' | 'circles' | 'messages' | 'activity' | 'you';

export interface NavItem { key: NavKey; href: string; icon: IconName; label: MessageKey }

/** The five destinations (docs/v2/00-brief.md §4): bottom tabs on phones, the rail on larger screens. */
export const NAV: NavItem[] = [
  { key: 'home', href: '/home', icon: 'home', label: 'nav.home' },
  { key: 'circles', href: '/circles', icon: 'circles', label: 'nav.circles' },
  { key: 'messages', href: '/messages', icon: 'messages', label: 'nav.messages' },
  { key: 'activity', href: '/activity', icon: 'activity', label: 'nav.activity' },
  { key: 'you', href: '/you', icon: 'you', label: 'nav.you' },
];

/** Sections without a tab of their own, highlighted under the tab they belong to. */
export const NAV_SECTIONS: { prefix: string; key: NavKey }[] = [
  { prefix: '/albums', key: 'you' }, // circles stream: albums live under You (circle albums open from a circle)
];

export function activeNav(path: string): NavKey | null {
  for (const n of NAV) if (path === n.href || path.startsWith(`${n.href}/`)) return n.key;
  for (const s of NAV_SECTIONS) if (path === s.prefix || path.startsWith(`${s.prefix}/`)) return s.key;
  return null;
}
