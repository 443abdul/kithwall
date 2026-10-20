'use client';
// Mobile "Menu" tab: everything that lives in the 2010 left nav, account menu and footer on desktop.
import Link from 'next/link';
import { AppPage } from '@/components/Shell';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { signOut, useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { useIsStaff, usePokes } from '@/lib/hooks';
import { setThemePref, useThemePref, type ThemePref } from '@/lib/theme';

const SHORTCUTS: [string, string, string][] = [
  ['/photos', 'Photos', 'photo'], ['/events', 'Events', 'event'], ['/groups', 'Groups', 'group'],
  ['/places', 'Places', 'place'], ['/questions', 'Questions', 'question'], ['/notes', 'Notes', 'note'],
  ['/games/kithville', 'Kithville', 'game'], ['/pokes', 'Pokes', 'poke'], ['/pages', 'Pages', 'page'],
  ['/invite', 'Invite friends', 'friends'],
];

export default function MenuPage() {
  const { userId, profile } = useSession();
  const me = usePerson(userId);
  const staff = useIsStaff();
  const pokes = usePokes();
  const theme = useThemePref();
  return (
    <AppPage bare>
      <div className="m-menu">
        <h1 className="m-h1">Menu</h1>
        {profile && (
          <Link href={`/${profile.username}`} className="m-card m-me-card">
            {userId ? <Avatar id={userId} size={48} /> : null}
            <span><b>{me?.name ?? profile.username}</b><span className="m-sub">See your profile</span></span>
          </Link>
        )}
        <div className="m-grid">
          {SHORTCUTS.map(([href, label, icon]) => (
            <Link key={href} href={href} className="m-card m-short">
              <Icon name={icon} />
              <span>{label}{href === '/pokes' && pokes.data?.length ? <span className="m-pill">{pokes.data.length}</span> : null}</span>
            </Link>
          ))}
        </div>
        <div className="m-section">Appearance</div>
        <div className="m-card m-seg" role="radiogroup" aria-label="Appearance">
          {([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [ThemePref, string][]).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={theme === v} className={theme === v ? 'on' : ''} onClick={() => setThemePref(v)}>{label}</button>
          ))}
        </div>
        <div className="m-section">Settings &amp; privacy</div>
        <div className="m-card m-rows">
          <Link href="/settings/profile"><Icon name="info" /> Edit profile</Link>
          <Link href="/settings/privacy"><Icon name="lock" /> Privacy</Link>
          <Link href="/settings/security"><Icon name="key" /> Security &amp; recovery</Link>
          <Link href="/settings/account"><Icon name="app" /> Account</Link>
          {staff.data && <Link href="/mod"><Icon name="shield" /> Moderation{staff.data === 'admin' ? ' & admin' : ''}</Link>}
        </div>
        <div className="m-section">Help &amp; legal</div>
        <div className="m-card m-rows">
          <Link href="/help"><Icon name="question" /> Help Center</Link>
          <Link href="/legal/privacy"><Icon name="lock" /> Privacy Policy</Link>
          <Link href="/legal/terms"><Icon name="note" /> Terms</Link>
          <Link href="/legal/community"><Icon name="group" /> Community Standards</Link>
        </div>
        <button type="button" className="m-logout" onClick={() => void signOut().then(() => { location.href = '/'; })}>Log out</button>
        <p className="m-foot">Kithwall &copy; {new Date().getFullYear()} &middot; End-to-end encrypted</p>
      </div>
    </AppPage>
  );
}
