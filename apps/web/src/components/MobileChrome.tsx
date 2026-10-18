'use client';
// Mobile app chrome (< 768 px): a compact top app bar and a bottom tab bar, the way 2026 phone apps
// work. Desktop keeps the 2010 header + left nav; CSS hides one or the other (styles/mobile.css).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/keys/session';
import { useConversations, useNotifications, useRequests } from '@/lib/hooks';
import { Avatar } from './Avatar';

const I = {
  home: (on: boolean) => <svg viewBox="0 0 24 24" aria-hidden><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /></svg>,
  friends: (on: boolean) => <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3.6" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" /><path d="M2.5 20c.4-3.8 3.2-6 6.5-6s6.1 2.2 6.5 6z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M17.5 14.3c2.2.7 3.7 2.7 4 5.7" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>,
  chat: (on: boolean) => <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3.5c5 0 9 3.6 9 8s-4 8-9 8c-1 0-2-.1-2.9-.4L4.5 21l1.2-3.9C4 15.6 3 13.6 3 11.5c0-4.4 4-8 9-8z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /></svg>,
  bell: (on: boolean) => <svg viewBox="0 0 24 24" aria-hidden><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.6 2H4.4z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" /><path d="M9.8 20.5a2.4 2.4 0 0 0 4.4 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>,
  search: <svg viewBox="0 0 24 24" aria-hidden><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" /><path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>,
  plus: <svg viewBox="0 0 24 24" aria-hidden><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>,
};

type Tab = 'home' | 'friends' | 'messages' | 'notifications' | 'menu';

function activeTab(path: string): Tab | null {
  if (path === '/') return 'home';
  if (path.startsWith('/friends') || path.startsWith('/requests') || path.startsWith('/pokes')) return 'friends';
  if (path.startsWith('/messages')) return 'messages';
  if (path.startsWith('/notifications')) return 'notifications';
  if (path.startsWith('/menu')) return 'menu';
  return null;
}

export function MobileChrome() {
  const path = usePathname() ?? '/';
  const { userId } = useSession();
  const reqs = useRequests();
  const convs = useConversations();
  const notifs = useNotifications(20);
  const tab = activeTab(path);
  const inThread = /^\/messages\/(?!new)[^/]+/.test(path);

  // Thread screens use the whole height for the conversation + composer (like messaging apps).
  useEffect(() => {
    document.body.classList.toggle('m-thread', inThread);
    return () => document.body.classList.remove('m-thread');
  }, [inThread]);

  // "+" in the top bar opens the feed with the composer focused.
  useEffect(() => {
    if (path !== '/' || !location.search.includes('compose=1')) return;
    const t = setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.pub textarea');
      ta?.scrollIntoView({ block: 'center' }); ta?.focus();
      history.replaceState(null, '', '/');
    }, 300);
    return () => clearTimeout(t);
  }, [path]);

  const n = {
    friends: reqs.data?.length ?? 0,
    messages: convs.data?.filter((c) => c.unread).length ?? 0,
    notifications: notifs.data?.filter((x) => !x.read_at).length ?? 0,
  };
  const item = (key: Tab, href: string, label: string, icon: React.ReactNode, count = 0) => (
    <Link href={href} className={`m-tab${tab === key ? ' on' : ''}`} aria-current={tab === key ? 'page' : undefined}
      aria-label={count ? `${label}, ${count} new` : label}>
      <span className="m-ico">{icon}{count ? <span className="m-badge">{count > 99 ? '99+' : count}</span> : null}</span>
      <span className="m-lbl">{label}</span>
    </Link>
  );

  return (
    <>
      <header className="m-top">
        <Link href="/" className="m-logo">kithwall</Link>
        <div className="m-top-actions">
          <Link href="/?compose=1" className="m-iconbtn" aria-label="Create a post">{I.plus}</Link>
          <Link href="/search" className="m-iconbtn" aria-label="Search">{I.search}</Link>
        </div>
      </header>
      <nav className="m-tabs" aria-label="Main">
        {item('home', '/', 'Home', I.home(tab === 'home'))}
        {item('friends', '/friends', 'Friends', I.friends(tab === 'friends'), n.friends)}
        {item('messages', '/messages', 'Messages', I.chat(tab === 'messages'), n.messages)}
        {item('notifications', '/notifications', 'Alerts', I.bell(tab === 'notifications'), n.notifications)}
        <Link href="/menu" className={`m-tab${tab === 'menu' ? ' on' : ''}`} aria-current={tab === 'menu' ? 'page' : undefined} aria-label="Menu">
          <span className="m-ico m-me">{userId ? <Avatar id={userId} size={26} /> : null}</span>
          <span className="m-lbl">Menu</span>
        </Link>
      </nav>
    </>
  );
}
