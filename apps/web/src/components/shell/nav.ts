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

export function activeNav(path: string): NavKey | null {
  for (const n of NAV) if (path === n.href || path.startsWith(`${n.href}/`)) return n.key;
  return null;
}
