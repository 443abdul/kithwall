'use client';
// The 2010 frame: blue header with jewels, left nav, centre column, right column, footer, chat dock.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon, JewelIcon } from './Icon';
import { Avatar, AvatarLink } from './Avatar';
import { ChatDock } from './ChatDock';
import { UnlockScreen } from './UnlockScreen';
import { signOut, useSession } from '@/lib/keys/session';
import { useConversations, useIsStaff, useNotifications, useRequests, usePokes } from '@/lib/hooks';
import { usePerson, people, usePeopleVersion } from '@/lib/people';
import { acceptFriend, ignoreRequest } from '@/lib/friends';
import { markAllRead, notifHref, notifText, NOTIF_ICON, preview } from '@/lib/notifications';
import { when, plural } from '@/lib/format';
import { sb } from '@/lib/supabase';
import type { ProfileRow } from '@/lib/types';

type Jewel = 'req' | 'msg' | 'notif' | null;

export function Header() {
  const { userId, profile } = useSession();
  const [jewel, setJewel] = useState<Jewel>(null);
  const [acct, setAcct] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const path = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const reqs = useRequests();
  const notifs = useNotifications(20);
  const convs = useConversations();
  const staff = useIsStaff();
  const qc = useQueryClient();

  useEffect(() => { setJewel(null); setAcct(false); setSearchOpen(false); document.body.classList.remove('nav-open'); }, [path]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setJewel(null); setAcct(false); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setJewel(null); setAcct(false); } };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);

  const nReq = reqs.data?.length ?? 0;
  const nMsg = convs.data?.filter((c) => c.unread).length ?? 0;
  const nNotif = notifs.data?.filter((n) => !n.read_at).length ?? 0;

  const toggle = (j: Exclude<Jewel, null>) => {
    setAcct(false);
    setJewel((cur) => (cur === j ? null : j));
    if (j === 'notif' && nNotif) void markAllRead().then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  };

  const jw = (k: Exclude<Jewel, null>, n: number, title: string) => (
    <button type="button" className={`jw${jewel === k ? ' on' : ''}${n ? ' hot' : ''}`} title={title} aria-label={`${title}${n ? ` (${n} new)` : ''}`}
      aria-expanded={jewel === k} onClick={() => toggle(k)} style={{ border: 0, background: jewel === k ? '#fff' : 'transparent', cursor: 'pointer' }}>
      {JewelIcon[k]()}{n ? <span className="badge">{n}</span> : null}
    </button>
  );

  return (
    <div id="blue">
      <div id="hd" ref={ref}>
        <button type="button" className="navbtn" aria-label="Menu" onClick={() => document.body.classList.toggle('nav-open')}>
          <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden><path d="M0 2h20M0 8h20M0 14h20" stroke="#fff" strokeWidth="2.4" /></svg>
        </button>
        <Link id="logo" href="/">kithwall</Link>
        <div id="jewels">
          {jw('req', nReq, 'Friend Requests')}{jw('msg', nMsg, 'Messages')}{jw('notif', nNotif, 'Notifications')}
          {jewel === 'req' && <ReqFly />}
          {jewel === 'msg' && <MsgFly />}
          {jewel === 'notif' && <NotifFly />}
        </div>
        <SearchBox open={searchOpen} />
        <div id="rnav">
          <a className="navbtn" role="button" aria-label="Search" onClick={() => setSearchOpen((v) => !v)}>
            <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="#fff" strokeWidth="1.8" /><path d="M9.6 9.6l4.6 4.6" stroke="#fff" strokeWidth="2.2" /></svg>
          </a>
          <Link className="hide-m" href="/">Home</Link>
          <Link className="hide-m" href={profile ? `/${profile.username}` : '/'}>Profile</Link>
          <a className={acct ? 'on' : ''} role="button" aria-haspopup="menu" aria-expanded={acct} onClick={() => { setJewel(null); setAcct((v) => !v); }}>Account &#9662;</a>
          {acct && (
            <div id="acctm" role="menu">
              <Link href="/friends">Edit Friends</Link>
              <Link href="/settings/account">Account Settings</Link>
              <Link href="/settings/privacy">Privacy Settings</Link>
              <Link href="/settings/security">Security &amp; Recovery</Link>
              {staff.data && <Link href="/mod">Moderation{staff.data === 'admin' ? ' & Admin' : ''}</Link>}
              <Link href="/help">Help Center</Link>
              <hr />
              <a role="menuitem" onClick={() => void signOut().then(() => { location.href = '/'; })}>Log Out</a>
            </div>
          )}
        </div>
        {userId ? null : null}
      </div>
    </div>
  );
}

function ReqFly() {
  const reqs = useRequests();
  const qc = useQueryClient();
  usePeopleVersion();
  const act = async (fn: () => Promise<void>) => { await fn(); await qc.invalidateQueries({ queryKey: ['requests'] }); await qc.invalidateQueries({ queryKey: ['friends'] }); };
  return (
    <div className="fly" style={{ left: 0 }}>
      <div className="fh"><span>Friend Requests</span><Link href="/invite">Find Friends</Link></div>
      {(reqs.data ?? []).map((r) => {
        const p = people.person(r.requested_by);
        return (
          <div className="fit" key={r.requested_by}>
            <AvatarLink id={r.requested_by} size={50} />
            <div style={{ flex: 1 }}>
              <Link href={`/${p?.username ?? ''}`}><b>{p?.name ?? '…'}</b></Link>
              <div style={{ marginTop: 5 }}>
                <a className="btn b" onClick={() => void act(() => acceptFriend(r.requested_by))}>Confirm</a>{' '}
                <a className="btn" onClick={() => void act(() => ignoreRequest(r.requested_by))}>Not Now</a>
              </div>
            </div>
          </div>
        );
      })}
      {!reqs.data?.length && <div className="em">No new requests.</div>}
      <Link className="ff" href="/requests">See All Friend Requests</Link>
    </div>
  );
}

function MsgFly() {
  const convs = useConversations();
  const { userId } = useSession();
  usePeopleVersion();
  return (
    <div className="fly" style={{ left: 31 }}>
      <div className="fh"><span>Messages</span><Link href="/messages/new">Send a New Message</Link></div>
      {(convs.data ?? []).slice(0, 6).map((c) => {
        const others = c.members.filter((m) => m !== userId);
        const names = others.map((o) => people.person(o)?.name ?? '…').join(', ');
        return (
          <Link key={c.id} className={`fit${c.unread ? ' un' : ''}`} href={`/messages/${c.id}`}>
            {others[0] ? <Avatar id={others[0]} size={50} /> : null}
            <div style={{ flex: 1, minWidth: 0 }}><b>{names || 'Only you'}</b><div className="gray">{when(c.last_message_at)}</div></div>
          </Link>
        );
      })}
      {!convs.data?.length && <div className="em">No messages.</div>}
      <Link className="ff" href="/messages">See All Messages</Link>
    </div>
  );
}

function NotifFly() {
  const notifs = useNotifications(20);
  usePeopleVersion();
  return (
    <div className="fly" style={{ left: 62 }}>
      <div className="fh"><span>Notifications</span><Link href="/settings/account#notifications">Settings</Link></div>
      {(notifs.data ?? []).slice(0, 8).map((n) => {
        const a = people.person(n.actor_id);
        const pv = preview(n);
        return (
          <Link key={n.id} className={`fit${n.read_at ? '' : ' un'}`} href={notifHref(n, a?.username)}>
            <Avatar id={n.actor_id} size={32} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{a?.name ?? '…'}</b> {notifText(n.type)}{pv ? <> &ldquo;{pv}&rdquo;</> : null}
              <div className="gray" style={{ marginTop: 2 }}><Icon name={NOTIF_ICON[n.type] ?? 'globe'} /> {when(n.created_at)}</div>
            </div>
          </Link>
        );
      })}
      {!notifs.data?.length && <div className="em">No new notifications.</div>}
      <Link className="ff" href="/notifications">See All Notifications</Link>
    </div>
  );
}

function SearchBox({ open }: { open: boolean }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProfileRow[]>([]);
  const router = useRouter();
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
      const { data } = await sb().from('profiles').select('*')
        .or(`username.ilike.${like},display_name_public.ilike.${like}`).limit(8);
      const rows = (data ?? []) as ProfileRow[];
      await people.ensure(rows.map((r) => r.id));
      setHits(rows);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  usePeopleVersion();
  return (
    <form id="srch" className={open ? 'open' : ''} role="search" autoComplete="off"
      onSubmit={(e) => { e.preventDefault(); router.push(`/search?q=${encodeURIComponent(q)}`); setHits([]); }}>
      <input name="q" placeholder="Search" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      <button title="Search" aria-label="Search"><Icon name="mag" /></button>
      {hits.length > 0 && (
        <div id="ta">
          {hits.map((h) => {
            const p = people.person(h.id);
            return (
              <Link key={h.id} href={`/${h.username}`} onClick={() => { setHits([]); setQ(''); }}>
                <Avatar id={h.id} size={32} /><div><b>{p?.name ?? h.username}</b><div className="k">@{h.username}</div></div>
              </Link>
            );
          })}
          <Link className="all" href={`/search?q=${encodeURIComponent(q)}`} onClick={() => setHits([])}>See more results for &ldquo;{q}&rdquo;</Link>
        </div>
      )}
    </form>
  );
}

export type NavKey = 'home' | 'messages' | 'events' | 'photos' | 'friends' | 'groups' | 'places' | 'kithville' | 'questions'
  | 'pages' | 'notes' | 'pokes' | 'apps' | 'none';

export function LeftNav({ active }: { active: NavKey }) {
  const { userId, profile } = useSession();
  const me = usePerson(userId);
  const convs = useConversations();
  const reqs = useRequests();
  const pokes = usePokes();
  const [more, setMore] = useState(['pages', 'notes', 'pokes', 'apps'].includes(active));
  const unread = convs.data?.filter((c) => c.unread).length ?? 0;
  const it = (k: NavKey, label: string, href: string, icon: string, n?: number) => (
    <li key={k}><Link className={active === k ? 'on' : ''} href={href} aria-current={active === k ? 'page' : undefined}>
      <Icon name={icon} /><span className="lbl">{label}</span>{n ? <span className="n">{n}</span> : null}
    </Link></li>
  );
  return (
    <nav id="lnav" aria-label="Main">
      <div className="me">
        {userId && <AvatarLink id={userId} size={50} />}
        <div><Link className="nm" href={profile ? `/${profile.username}` : '/'}>{me?.name ?? profile?.username}</Link><br />
          <Link className="ed" href="/settings/profile">Edit My Profile</Link></div>
      </div>
      <ul>
        {it('home', 'News Feed', '/', 'feed')}
        {it('messages', 'Messages', '/messages', 'msg', unread)}
        {it('events', 'Events', '/events', 'event')}
        {it('photos', 'Photos', '/photos', 'photo')}
        {it('friends', 'Friends', '/friends', 'friends', reqs.data?.length)}
      </ul>
      <div className="sep" />
      <ul>
        {it('groups', 'Groups', '/groups', 'group')}
        {it('places', 'Places', '/places', 'place')}
        {it('kithville', 'Kithville', '/games/kithville', 'game')}
        {it('questions', 'Questions', '/questions', 'question')}
        {more && <>{it('pages', 'Pages', '/pages', 'page')}{it('notes', 'Notes', '/notes', 'note')}
          {it('pokes', 'Pokes', '/pokes', 'poke', pokes.data?.length)}{it('apps', 'Apps and Games', '/apps', 'app')}</>}
      </ul>
      <a className="more" role="button" onClick={() => setMore((v) => !v)}>{more ? 'Less' : 'More'} {more ? null : <Icon name="more" />}</a>
    </nav>
  );
}

export function Footer() {
  return (
    <footer id="ft">
      <div>Kithwall &copy; {new Date().getFullYear()} &middot; English (US)</div>
      <div>
        <Link href="/help">About</Link> &middot; <Link href="/legal/privacy">Privacy</Link> &middot; <Link href="/legal/terms">Terms</Link>{' '}
        &middot; <Link href="/legal/community">Community Standards</Link> &middot; <Link href="/help">Help</Link>
      </div>
    </footer>
  );
}

export function Title({ icon, children, right }: { icon?: string; children: ReactNode; right?: ReactNode }) {
  return <div className="ttl"><h2>{icon ? <Icon name={icon} /> : null}{children}</h2><div className="r">{right}</div></div>;
}

/** Page frame for signed-in pages. Renders unlock/sign-in states when needed. */
export function AppPage({ active = 'none', right, children, wide = false, bare = false }:
  { active?: NavKey; right?: ReactNode; children: ReactNode; wide?: boolean; bare?: boolean }) {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signed_out') router.replace('/');
    if (status === 'setup') router.replace('/welcome');
  }, [status, router]);
  if (status === 'loading' || status === 'signed_out' || status === 'setup') return <Loading />;
  if (status === 'locked') return <UnlockScreen />;
  return (
    <>
      <Header />
      <main id="body">
        {bare ? children : (
          <div className="c3">
            <LeftNav active={active} />
            <div className="ctr" style={wide ? { paddingRight: 10 } : undefined}>{children}</div>
            {right != null && !wide ? <aside className="rcol">{right}</aside> : null}
          </div>
        )}
      </main>
      <Footer />
      <ChatDock />
    </>
  );
}

export function Loading() {
  return <div id="blue"><div id="hd"><span id="logo">kithwall</span></div></div>;
}

export function RightBox({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <div className="rs"><div className="rh"><span>{title}</span>{action}</div>{children}</div>;
}

export { plural };
