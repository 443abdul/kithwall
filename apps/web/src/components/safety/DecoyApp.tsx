'use client';
// Decoy mode (Safety centre §3): what the duress PIN opens. It looks like a brand-new, empty Kithwall
// account — the same frame, tabs and empty states as a real new account — but no keys are loaded,
// nothing is fetched, and the real screens are never mounted (AppGate renders this instead of them).
// Posts typed here stay on this screen only. "Lock" goes back to the PIN pad.
//
// Limits (stated in the Safety centre): it can't stop forensic analysis of a seized, unlocked device,
// and the account still exists on the server.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { signOut } from '@/lib/keys/session';
import { lockNow, type DecoyInfo } from '@/lib/safety/applock';
import { NAV, activeNav } from '@/components/shell/nav';
import { Page } from '@/components/shell/AppShell';
import { Logo } from '@/components/shell/Logo';
import { V2Root } from '@/components/shell/V2Root';
import { Avatar } from '@/components/ui/Avatar';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { List, ListItem } from '@/components/ui/ListItem';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { StylePicker } from '@/components/onboarding/StylePicker';
import { LanguagePicker } from '@/components/onboarding/LanguagePicker';

export function DecoyApp({ info }: { info: DecoyInfo }) {
  return <V2Root><DecoyShell info={info} /></V2Root>;
}

function DecoyShell({ info }: { info: DecoyInfo }) {
  const t = useT();
  const path = usePathname() ?? '/home';
  const active = activeNav(path) ?? 'home';
  const [posts, setPosts] = useState<{ id: number; text: string }[]>([]);
  const name = info.name || info.handle || t('you.unnamed');

  const items = (variant: 'rail' | 'tabs') => NAV.map((n) => (
    <li key={n.key}>
      <Link href={n.href} className={variant === 'rail' ? 'k-rail-item' : 'k-tab-item'} aria-current={active === n.key ? 'page' : undefined}>
        <span className="k-nav-ico">{n.key === 'you' && variant === 'rail' ? <Avatar name={name} size={28} /> : <Icon name={n.icon} />}</span>
        <span className="k-nav-label">{t(n.label)}</span>
      </Link>
    </li>
  ));

  let screen;
  if (path.startsWith('/you/settings')) screen = <DecoySettings />;
  else if (active === 'you') screen = <DecoyYou name={name} handle={info.handle} />;
  else if (active === 'circles') screen = <DecoyEmpty title={t('nav.circles')} icon="circles" heading={t('circles.emptyTitle')} body={t('circles.emptyBody')} />;
  else if (active === 'messages') screen = <DecoyEmpty title={t('nav.messages')} icon="messages" heading={t('messages.emptyTitle')} body={t('messages.emptyBody')} />;
  else if (active === 'activity') screen = <DecoyEmpty title={t('nav.activity')} icon="activity" heading={t('activity.caughtUp')} body={t('activity.caughtUpBody')} />;
  else screen = <DecoyHome name={name} posts={posts} onPost={(text) => setPosts((p) => [{ id: Date.now(), text }, ...p])} />;

  return (
    <div className="k-app">
      <a className="k-skip" href="#main">{t('shell.skip')}</a>
      <header className="k-topbar">
        <Link href="/home" className="k-topbar-brand" aria-label={t('shell.homeLink')}><Logo size={30} /></Link>
        <div className="k-topbar-actions">
          <Link href="/you/settings" className="k-iconbtn" aria-label={t('settings.title')} title={t('settings.title')}><Icon name="settings" /></Link>
        </div>
      </header>
      <nav className="k-rail" aria-label={t('shell.mainNav')}>
        <Link href="/home" className="k-rail-brand" aria-label={t('shell.homeLink')}><Logo size={36} /></Link>
        <ul role="list" className="k-rail-list">{items('rail')}</ul>
        <div className="k-rail-foot">
          <Link href="/you/settings" className="k-rail-item" aria-current={path.startsWith('/you/settings') ? 'page' : undefined}>
            <span className="k-nav-ico"><Icon name="settings" /></span>
            <span className="k-nav-label">{t('settings.title')}</span>
          </Link>
        </div>
      </nav>
      <div className="k-app-body">{screen}</div>
      <nav className="k-tabbar" aria-label={t('shell.mainNav')}><ul role="list">{items('tabs')}</ul></nav>
    </div>
  );
}

function DecoyHome({ name, posts, onPost }: { name: string; posts: { id: number; text: string }[]; onPost: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  useDocumentTitle(t('home.title'));
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    onPost(text.trim());
    setText('');
  }
  return (
    <Page title={t('home.title')}>
      <Card className="k-composer">
        <form onSubmit={submit} aria-label={t('feed.composerLabel')}>
          <div className="k-composer-top">
            <Avatar name={name} size={40} />
            <label htmlFor="k-decoy-compose" className="k-sr-only">{t('feed.composerPlaceholder')}</label>
            <textarea id="k-decoy-compose" className="k-composer-text" dir="auto" rows={2} value={text}
              placeholder={t('feed.composerPlaceholder')} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="k-composer-bar">
            <span className="k-spacer" />
            <Button type="submit" variant="primary" size="sm" disabled={!text.trim()}>{t('feed.post')}</Button>
          </div>
        </form>
      </Card>
      {posts.map((p) => (
        <Card key={p.id}>
          <div className="k-decoy-post">
            <Avatar name={name} size={40} />
            <div>
              <p className="k-decoy-post-who"><strong>{name}</strong> <span className="k-muted k-small">· {t('feed.justNow')}</span></p>
              <p dir="auto" className="k-decoy-post-text">{p.text}</p>
            </div>
          </div>
        </Card>
      ))}
      {posts.length ? null : (
        <Card>
          <EmptyState icon="home" title={t('home.emptyTitle')} body={t('home.emptyBody')}
            actions={<ButtonLink href="/you" variant="primary" icon="userPlus">{t('home.invite')}</ButtonLink>} />
        </Card>
      )}
    </Page>
  );
}

function DecoyEmpty({ title, icon, heading, body }: { title: string; icon: 'circles' | 'messages' | 'activity'; heading: string; body: string }) {
  useDocumentTitle(title);
  return (
    <Page title={title}>
      <Card><EmptyState icon={icon} title={heading} body={body} /></Card>
    </Page>
  );
}

function DecoyYou({ name, handle }: { name: string; handle: string }) {
  const t = useT();
  useDocumentTitle(t('nav.you'));
  return (
    <Page title={t('nav.you')}>
      <Card className="k-you-card">
        <Avatar name={name} size={72} />
        <div className="k-you-text">
          <h2>{name}</h2>
          {handle ? <p className="k-muted k-ltr">@{handle}</p> : null}
        </div>
      </Card>
      <Card padding="flush">
        <List label={t('people.title')}>
          <li><ListItem icon="users" title={t('people.title')} subtitle={t('people.count', { count: 0 })} /></li>
        </List>
      </Card>
      <Card padding="flush">
        <List label={t('settings.title')}>
          <li><ListItem icon="settings" title={t('settings.title')} subtitle={t('you.settingsSub')} href="/you/settings" /></li>
          <li><ListItem icon="lock" title={t('settings.device.lock')} onClick={() => void lockNow()} chevron={false} /></li>
          <li><ListItem icon="logout" title={t('you.signOut')} onClick={() => void signOut().finally(() => { location.href = '/'; })} chevron={false} /></li>
        </List>
      </Card>
    </Page>
  );
}

function DecoySettings() {
  const t = useT();
  useDocumentTitle(t('settings.title'));
  return (
    <Page title={t('settings.title')} back={{ href: '/you', label: t('common.back') }}>
      <section className="k-stack" aria-labelledby="decoy-appearance-h">
        <h2 id="decoy-appearance-h" className="k-section-title">{t('settings.appearance')}</h2>
        <Card><div className="k-stack"><p className="k-muted k-small">{t('settings.appearanceBody')}</p><StylePicker headingId="decoy-appearance-h" /></div></Card>
      </section>
      <section className="k-stack" aria-labelledby="decoy-language-h">
        <h2 id="decoy-language-h" className="k-section-title">{t('settings.language')}</h2>
        <Card><div className="k-stack"><LanguagePicker /><p className="k-muted k-small">{t('settings.languageNote')}</p></div></Card>
      </section>
      <Card>
        <div className="k-row-wrap">
          <Button variant="secondary" icon="lock" onClick={() => void lockNow()}>{t('settings.device.lock')}</Button>
          <Button variant="ghost" icon="logout" onClick={() => void signOut().finally(() => { location.href = '/'; })}>{t('you.signOut')}</Button>
        </div>
      </Card>
    </Page>
  );
}
