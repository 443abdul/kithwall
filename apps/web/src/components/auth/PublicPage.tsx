'use client';
// Frame for pages that work signed in or signed out (legal, help, login, recovery):
// the normal header when unlocked, otherwise the logged-out blue bar with the login form.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSession } from '@/lib/keys/session';
import { Footer, Header } from '@/components/Shell';
import { MobileChrome } from '@/components/MobileChrome';
import { LoggedOutHeader } from '@/components/auth/Splash';
import '@/styles/auth.css';

export function PublicPage({ children, plainHeader = false }: { children: ReactNode; plainHeader?: boolean }) {
  const { status } = useSession();
  const header = status === 'ready' ? <><Header /><MobileChrome /></>
    : plainHeader || status === 'loading' ? <div id="sblue"><div className="in"><Link className="lg" href="/">kithwall</Link></div></div>
    : <LoggedOutHeader />;
  return (
    <>
      {header}
      <main className="kw-pub-main">{children}</main>
      <Footer />
    </>
  );
}
