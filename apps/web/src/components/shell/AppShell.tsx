'use client';
// Signed-in app frame (docs/v2/00-brief.md §4, §6):
//   phone (< 768px):   top app bar + bottom tab bar (safe-area aware)
//   tablet (768–1023): left rail, icons only
//   desktop (≥ 1024):  left rail with labels + main column + optional context panel (see <Page/>)
// The rail sits on the inline-start side, so it moves to the right in RTL languages.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import { useConversations, useNotifications, useRequests } from '@/lib/hooks';
import { useHiddenChats } from '@/lib/safety/hidden';
import { Icon } from '@/components/ui/Icon';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { AccountNotices } from './AccountNotices';
import { PullToRefresh } from '@/components/PullToRefresh';
import { Logo } from './Logo';
import { NAV, activeNav, type NavKey } from './nav';

/** Path prefix for shell links (only the dev-only /design preview sets one). */
const BaseContext = createContext('');
export function useShellHref(): (path: string) => string {
  const base = useContext(BaseContext);
  return (path) => `${base}${path}`;
}

function useBadges(): Partial<Record<NavKey, number>> {
  const reqs = useRequests();
  const convs = useConversations();
  const notifs = useNotifications(20);
  const hidden = useHiddenChats();
  return {
    messages: convs.data?.filter((c) => c.unread && !hidden.has(c.id)).length ?? 0,
    activity: (notifs.data?.filter((x) => !x.read_at).length ?? 0) + (reqs.data?.length ?? 0),
  };
}

export function useMe() {
  const { userId, profile } = useSession();
  const p = usePerson(userId);
  const url = useFileUrl(p?.info?.avatar?.thumb);
  return { userId, name: p?.name ?? profile?.username ?? '', handle: profile?.username ?? '', avatar: url ?? null };
}

export function AppShell({ children, base = '' }: { children: ReactNode; base?: string }) {
  const t = useT();
  const raw = usePathname() ?? '/home';
  const path = base && raw.startsWith(base) ? raw.slice(base.length) || '/' : raw;
  const active = activeNav(path);
  const href = (p: string) => `${base}${p}`;
  const badges = useBadges();
  const me = useMe();

  const navItems = (variant: 'rail' | 'tabs') => NAV.map((n) => {
    const on = active === n.key;
    const count = badges[n.key] ?? 0;
    const label = t(n.label);
    return (
      <li key={n.key}>
        <Link
          href={href(n.href)}
          className={variant === 'rail' ? 'k-rail-item' : 'k-tab-item'}
          aria-current={on ? 'page' : undefined}
          aria-label={count ? t('nav.withCount', { label, count }) : undefined}
        >
          <span className="k-nav-ico">
            {n.key === 'you' && variant === 'rail' ? <Avatar name={me.name} src={me.avatar} size={28} /> : <Icon name={n.icon} />}
            {count ? <Badge count={count} /> : null}
          </span>
          <span className="k-nav-label">{label}</span>
        </Link>
      </li>
    );
  });

  return (
    <BaseContext.Provider value={base}>
    <div className="k-app">
      <a className="k-skip" href="#main">{t('shell.skip')}</a>
      <PullToRefresh />

      <header className="k-topbar">
        <Link href={href('/home')} className="k-topbar-brand" aria-label={t('shell.homeLink')}><Logo size={30} /></Link>
        <div className="k-topbar-actions">
          {/* Finding people (by @handle, invite link or QR) lives on Connections; there is no content search (it's encrypted). */}
          <Link href={href('/people')} className="k-iconbtn" aria-label={t('shell.search')} title={t('shell.search')}><Icon name="search" /></Link>
          <Link href={href('/you/settings')} className="k-iconbtn" aria-label={t('settings.title')} title={t('settings.title')}><Icon name="settings" /></Link>
        </div>
      </header>

      <nav className="k-rail" aria-label={t('shell.mainNav')}>
        <Link href={href('/home')} className="k-rail-brand" aria-label={t('shell.homeLink')}><Logo size={36} /></Link>
        <ul role="list" className="k-rail-list">{navItems('rail')}</ul>
        <div className="k-rail-foot">
          <Link href={href('/you/settings')} className="k-rail-item" aria-current={path.startsWith('/you/settings') ? 'page' : undefined}>
            <span className="k-nav-ico"><Icon name="settings" /></span>
            <span className="k-nav-label">{t('settings.title')}</span>
          </Link>
        </div>
      </nav>

      <div className="k-app-body">{base ? null : <AccountNotices />}{children}</div>

      <nav className="k-tabbar" aria-label={t('shell.mainNav')}>
        <ul role="list">{navItems('tabs')}</ul>
      </nav>
    </div>
    </BaseContext.Provider>
  );
}

/**
 * A screen inside the shell: page heading + main column, and an optional context panel that shows
 * beside it on wide screens (and below it on narrow ones when `contextOnPhone` is set).
 */
export function Page({ title, description, actions, context, children, back }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  context?: ReactNode;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  const shellHref = useShellHref();
  return (
    <div className={context ? 'k-page k-page-has-context' : 'k-page'}>
      <main id="main" className="k-main" tabIndex={-1}>
        <header className="k-page-head">
          {back ? (
            <Link href={shellHref(back.href)} className="k-iconbtn k-page-back" aria-label={back.label} title={back.label}><Icon name="back" /></Link>
          ) : null}
          <div className="k-page-titles">
            <h1>{title}</h1>
            {description ? <p className="k-muted">{description}</p> : null}
          </div>
          {actions ? <div className="k-page-actions">{actions}</div> : null}
        </header>
        {children}
      </main>
      {context ? <aside className="k-context">{context}</aside> : null}
    </div>
  );
}
