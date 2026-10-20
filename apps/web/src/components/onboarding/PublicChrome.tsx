'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { Logo } from '@/components/shell/Logo';
import { ButtonLink } from '@/components/ui/Button';
import { LanguagePicker } from './LanguagePicker';

export type PublicCta = 'signin' | 'join' | 'none' | 'auto';

/** Header for public pages: logo, language, and a sign-in / join link ('auto': back to the app when signed in). */
export function PublicHeader({ cta = 'signin' }: { cta?: PublicCta }) {
  const t = useT();
  const { status } = useSession();
  const inApp = cta === 'auto' && (status === 'ready' || status === 'locked');
  if (cta === 'auto') cta = inApp ? 'none' : 'signin';
  return (
    <header className="k-pub-head">
      <Link href="/" className="k-pub-brand" aria-label={t('shell.homeLink')}><Logo size={32} /></Link>
      <div className="k-pub-head-actions">
        <LanguagePicker compact />
        {cta === 'signin' ? <ButtonLink href="/signin" variant="ghost" size="sm">{t('landing.signIn')}</ButtonLink> : null}
        {cta === 'join' ? <ButtonLink href="/join" variant="ghost" size="sm">{t('landing.join')}</ButtonLink> : null}
        {inApp ? <ButtonLink href="/home" variant="soft" size="sm">{t('public.openApp')}</ButtonLink> : null}
      </div>
    </header>
  );
}

export function PublicFooter() {
  const t = useT();
  return (
    <footer className="k-pub-foot">
      <nav aria-label={t('footer.label')}>
        <ul role="list" className="k-pub-foot-links">
          <li><Link href="/legal/privacy">{t('footer.privacy')}</Link></li>
          <li><Link href="/legal/terms">{t('footer.terms')}</Link></li>
          <li><Link href="/legal/community">{t('footer.community')}</Link></li>
          <li><Link href="/legal/law-enforcement">{t('footer.lawEnforcement')}</Link></li>
          <li><Link href="/help">{t('footer.help')}</Link></li>
        </ul>
      </nav>
      <p className="k-muted k-small">{t('footer.tagline')}</p>
    </footer>
  );
}

/** Centred single-column card layout used by /join and /signin. */
export function AuthFrame({ children, cta }: { children: ReactNode; cta?: PublicCta }) {
  return (
    <div className="k-auth">
      <PublicHeader cta={cta} />
      <main id="main" className="k-auth-main">{children}</main>
      <PublicFooter />
    </div>
  );
}

/** Wide single-column frame for public reading pages (legal documents, help). */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="k-auth k-public">
      <PublicHeader cta="auto" />
      <main id="main" className="k-public-main">{children}</main>
      <PublicFooter />
    </div>
  );
}
