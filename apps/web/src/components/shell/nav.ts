import type { IconName } from '@/components/ui/Icon';
import type { MessageKey } from '@/i18n';

export type NavKey = 'home' | 'explore' | 'circles' | 'messages' | 'activity' | 'you';

export interface NavItem { key: NavKey; href: string; icon: IconName; label: MessageKey }

/**
 * The main destinations (docs/v2/00-brief.md §4; Explore: docs/v2/10-follow-public.md §5): bottom tabs on
 * phones, the rail on larger screens. The tab bar lays out however many entries are listed here.
 */
export const NAV: NavItem[] = [
  { key: 'home', href: '/home', icon: 'home', label: 'nav.home' },
  { key: 'explore', href: '/explore', icon: 'compass', label: 'nav.explore' },
  { key: 'circles', href: '/circles', icon: 'circles', label: 'nav.circles' },
  { key: 'messages', href: '/messages', icon: 'messages', label: 'nav.messages' },
  { key: 'activity', href: '/activity', icon: 'activity', label: 'nav.activity' },
  { key: 'you', href: '/you', icon: 'you', label: 'nav.you' },
];

/** Sections without a tab of their own, highlighted under the tab they belong to. */
export const NAV_SECTIONS: { prefix: string; key: NavKey }[] = [
  { prefix: '/albums', key: 'you' }, // albums live under You (circle albums open from a circle)
  { prefix: '/events', key: 'circles' },
  { prefix: '/notes', key: 'circles' },
  { prefix: '/people', key: 'you' },
  { prefix: '/post', key: 'home' },
  // Reels open from Explore and from Home. No tab of their own: six are as many as fit on a phone.
  { prefix: '/reels', key: 'explore' },
  { prefix: '/mod', key: 'you' },
];

export function activeNav(path: string): NavKey | null {
  for (const n of NAV) if (path === n.href || path.startsWith(`${n.href}/`)) return n.key;
  for (const s of NAV_SECTIONS) if (path === s.prefix || path.startsWith(`${s.prefix}/`)) return s.key;
  return null;
}
