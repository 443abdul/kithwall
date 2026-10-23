'use client';
// Help Center (/help): works signed in or out. Questions and answers are translated messages
// (content/help.ts); answers use a small Markdown subset rendered as React elements.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { HELP } from '@/content/help';
import { renderMarkdown } from '@/components/auth/Markdown';
import { TextField } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';

/** In-app links and http(s) only. */
const helpLink = (href: string) => (href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#') || /^https:\/\//i.test(href) ? href : null;

export function HelpScreen() {
  const t = useT();
  const [q, setQ] = useState('');
  useDocumentTitle(t('help.title'));
  const sections = useMemo(() => {
    const term = q.trim().toLocaleLowerCase();
    const all = HELP.map((s) => ({ ...s, items: s.items.map((i) => ({ q: t(i.q), a: t(i.a) })) }));
    if (!term) return all;
    return all.map((s) => ({ ...s, items: s.items.filter((i) => `${i.q} ${i.a}`.toLocaleLowerCase().includes(term)) }))
      .filter((s) => s.items.length);
  }, [q, t]);

  return (
    <PublicFrame>
      <div className="k-doc-layout">
        <header className="k-doc-head">
          <h1>{t('help.title')}</h1>
          <p className="k-muted">{t('help.lede')}</p>
          <TextField type="search" label={t('help.search')} hideLabel placeholder={t('help.search')} value={q}
            onChange={(e) => setQ(e.target.value)} />
        </header>
        <nav className="k-doc-nav" aria-label={t('help.sections')}>
          <ul role="list">
            {HELP.map((s) => <li key={s.id}><a href={`#${s.id}`}>{t(s.title)}</a></li>)}
          </ul>
        </nav>
        <div className="k-doc-body">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="k-help-section" aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{t(s.title)}</h2>
              {s.items.map((i) => (
                <details key={i.q} className="k-faq" open={!!q.trim()}>
                  <summary>{i.q}</summary>
                  <div className="kn-prose k-faq-answer" dir="auto">{renderMarkdown(i.a, helpLink)}</div>
                </details>
              ))}
            </section>
          ))}
          {!sections.length ? <EmptyState icon="search" title={t('help.noMatch', { query: q.trim() })} /> : null}
          <p className="k-small"><Link href="/help/blocked">{t('net.help.link')}</Link></p>
          <p className="k-muted k-small k-doc-foot">
            {t('help.more')} <Link href="/legal/privacy">{t('footer.privacy')}</Link> · <Link href="/legal/terms">{t('footer.terms')}</Link> · <Link href="/legal/community">{t('footer.community')}</Link>
          </p>
        </div>
      </div>
    </PublicFrame>
  );
}
