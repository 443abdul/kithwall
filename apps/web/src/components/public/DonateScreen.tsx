'use client';
// /donate (public, works signed in or out). Kithwall is free and open source and doesn't take donations
// yet, so this page is mostly "other ways to help". Donation methods come from build-time config
// (lib/donate.ts) and appear only when set and well-formed. QR codes are drawn on this device (lib/qr.ts).
// On iOS, Apple only allows in-app donation links for registered nonprofits (docs/v2/00-brief.md §9), so the
// app shows a pointer to the website instead of the methods.
import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';
import { LOCALES, LOCALE_NAMES, dirOf, useT } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { QrCode } from '@/components/people/InviteCard';
import { DONATE_METHODS, type DonateMethod } from '@/lib/donate';
import { useSession } from '@/lib/keys/session';
import { nativePlatform } from '@/lib/native';
import { REPO_URL, repoFileUrl } from '@/lib/source';

const SECURITY_EMAIL = 'security@kithwall.com';
const SITE_DONATE_URL = 'https://kithwall.com/donate';
const noSubscribe = () => () => {};

/** External link: new tab, no opener, no referrer. */
function ExtLink({ href, children, button }: { href: string; children: ReactNode; button?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={button ? 'k-btn k-btn-secondary k-btn-sm' : undefined}>
      {children}
    </a>
  );
}

export function DonateScreen({ methods = DONATE_METHODS }: { methods?: DonateMethod[] }) {
  const t = useT();
  const { status } = useSession();
  const signedIn = status === 'ready' || status === 'locked';
  const ios = useSyncExternalStore(noSubscribe, () => nativePlatform() === 'ios', () => false);
  useDocumentTitle(t('donate.title'));

  return (
    <PublicFrame>
      <div className="k-doc-layout k-donate-page">
        <header className="k-doc-head">
          <h1>{t('donate.title')}</h1>
          <p className="k-muted">{t('donate.lede')}</p>
        </header>
        <div className="k-doc-body">
          {!methods.length ? (
            <Callout tone="accent" icon="gift">
              <p><strong>{t('donate.closedTitle')}</strong></p>
              <p>{t('donate.closedBody')}</p>
            </Callout>
          ) : ios ? (
            <Callout tone="accent" icon="gift">
              <p>{t('donate.iosNote')}</p>
              <p><ExtLink href={SITE_DONATE_URL}>{t('donate.iosOpen')}</ExtLink></p>
            </Callout>
          ) : (
            <section aria-labelledby="donate-methods-h" className="k-stack">
              <h2 id="donate-methods-h">{t('donate.methodsTitle')}</h2>
              <p className="k-muted">{t('donate.methodsBody')}</p>
              <ul role="list" className="k-donate-methods">
                {methods.map((m) => <li key={m.kind}><MethodCard m={m} /></li>)}
              </ul>
            </section>
          )}

          <section aria-labelledby="donate-help-h" className="k-stack">
            <h2 id="donate-help-h">{t('donate.helpTitle')}</h2>
            <ul role="list" className="k-donate-ways">
              <Way icon="code" title={t('donate.codeTitle')} body={t('donate.codeBody')}>
                <ExtLink href={REPO_URL}>{t('donate.codeLink')}</ExtLink>
              </Way>
              <Way icon="globe" title={t('donate.translateTitle')} body={t('donate.translateBody')}>
                <ul role="list" className="k-donate-langs">
                  {LOCALES.map((l) => <li key={l} lang={l} dir={dirOf(l)}>{LOCALE_NAMES[l].native}</li>)}
                </ul>
                <ExtLink href={`${repoFileUrl('CONTRIBUTING.md')}#translations`}>{t('donate.translateLink')}</ExtLink>
              </Way>
              <Way icon="shield" title={t('donate.securityTitle')} body={t('donate.securityBody', { email: SECURITY_EMAIL })}>
                <ExtLink href={repoFileUrl('SECURITY.md')}>{t('donate.securityLink')}</ExtLink>
              </Way>
              <Way icon="share" title={t('donate.shareTitle')} body={t('donate.shareBody')}>
                {signedIn ? <Link href="/people?tab=invite">{t('donate.shareLink')}</Link> : <Link href="/join">{t('landing.join')}</Link>}
              </Way>
              <Way icon="layout" title={t('donate.hostTitle')} body={t('donate.hostBody')}>
                <ExtLink href={repoFileUrl('docs/deploy.md')}>{t('donate.hostLink')}</ExtLink>
              </Way>
            </ul>
          </section>
        </div>
      </div>
    </PublicFrame>
  );
}

function Way({ icon, title, body, children }: { icon: IconName; title: string; body: string; children: ReactNode }) {
  return (
    <li>
      <Card className="k-donate-way">
        <span className="k-donate-ico"><Icon name={icon} /></span>
        <div className="k-donate-way-body">
          <h3>{title}</h3>
          <p className="k-muted">{body}</p>
          <div className="k-donate-way-links">{children}</div>
        </div>
      </Card>
    </li>
  );
}

function MethodCard({ m }: { m: DonateMethod }) {
  const t = useT();
  const toast = useToast();
  if (m.kind === 'btcpay' || m.kind === 'sponsor') {
    return (
      <Card className="k-donate-method">
        <h3>{m.kind === 'btcpay' ? t('donate.btcpay') : t('donate.sponsor')}</h3>
        <p className="k-muted k-small">{m.kind === 'btcpay' ? t('donate.btcpayNote') : t('donate.sponsorNote')}</p>
        <ExtLink href={m.url} button>{m.kind === 'btcpay' ? t('donate.btcpayOpen') : t('donate.sponsorOpen')}</ExtLink>
      </Card>
    );
  }
  const name = m.kind === 'monero' ? t('donate.monero') : t('donate.bitcoin');
  const address = m.address;
  async function copy() {
    try { await navigator.clipboard.writeText(address); toast({ message: t('donate.copied') }); } catch { /* clipboard blocked: the address is selectable */ }
  }
  return (
    <Card className="k-donate-method">
      <h3>{name}</h3>
      <p className="k-muted k-small">{m.kind === 'monero' ? t('donate.moneroNote') : t('donate.bitcoinNote')}</p>
      <div className="k-donate-qr"><QrCode text={m.uri} label={t('donate.qr', { name })} size={176} /></div>
      <p className="k-label">{t('donate.address')}</p>
      <code className="k-donate-addr k-ltr" dir="ltr" translate="no">{m.address}</code>
      <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()}>{t('donate.copy')}</Button>
    </Card>
  );
}
