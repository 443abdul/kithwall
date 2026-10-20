'use client';
// Frame for one legal document: the public header/footer, a translated list of the documents and,
// outside English, a note that the document itself is in English. The body is rendered on the
// server (app/(public)/legal/[doc]/page.tsx) and passed in as React elements.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useLocale, useT } from '@/i18n';
import { Callout } from '@/components/ui/Callout';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { LEGAL_DOCS, LEGAL_SLUGS, type LegalSlug } from './legal';

export function LegalScreen({ slug, children }: { slug: LegalSlug; children: ReactNode }) {
  const t = useT();
  const { locale } = useLocale();
  useDocumentTitle(t(LEGAL_DOCS[slug].label));
  return (
    <PublicFrame>
      <div className="k-doc-layout">
        <nav className="k-doc-nav" aria-label={t('legal.nav')}>
          <ul role="list">
            {LEGAL_SLUGS.map((s) => (
              <li key={s}>
                <Link href={`/legal/${s}`} aria-current={s === slug ? 'page' : undefined}>{t(LEGAL_DOCS[s].label)}</Link>
              </li>
            ))}
            <li><Link href="/help">{t('help.title')}</Link></li>
          </ul>
        </nav>
        <div className="k-doc-body">
          {locale !== 'en' ? <Callout tone="info" icon="globe">{t('legal.englishOnly')}</Callout> : null}
          {/* The document's language is English whatever the page language is. */}
          <article className="kn-prose k-doc" lang="en" dir="ltr">{children}</article>
        </div>
      </div>
    </PublicFrame>
  );
}
