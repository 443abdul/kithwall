import 'server-only';
// Renders one of our legal documents (copied from docs/legal into src/content/legal so Vercel,
// which builds only apps/web, ships them). Read on the server; rendered as React elements.
import Link from 'next/link';
import { renderMarkdown, type LinkMapper } from '@/components/auth/Markdown';
import { PublicPage } from '@/components/auth/PublicPage';

export const LEGAL_DOCS = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy' },
  terms: { file: 'terms-of-service.md', title: 'Terms of Service' },
  community: { file: 'community-standards.md', title: 'Community Standards' },
  'law-enforcement': { file: 'law-enforcement-guidelines.md', title: 'Law Enforcement Guidelines' },
} as const;
export type LegalSlug = keyof typeof LEGAL_DOCS;

const BY_FILE = Object.fromEntries(Object.entries(LEGAL_DOCS).map(([slug, d]) => [d.file, slug])) as Record<string, string>;

/** Links between the documents become /legal/... routes; anything else in-repo is shown as plain text. */
const mapLink: LinkMapper = (href) => {
  if (/^https?:\/\//i.test(href) || href.startsWith('mailto:')) return href;
  if (href.startsWith('#')) return href;
  const [path, hash] = href.split('#');
  const slug = BY_FILE[(path ?? '').replace(/^\.\//, '')];
  return slug ? `/legal/${slug}${hash ? `#${hash}` : ''}` : null;
};

/** Each page reads its own file with a literal path, so output file tracing ships it. */
export function LegalDoc({ slug, src }: { slug: LegalSlug; src: string }) {
  return (
    <PublicPage>
      <nav className="kw-legalnav" aria-label="Legal documents">
        {(Object.keys(LEGAL_DOCS) as LegalSlug[]).map((s) => (
          s === slug ? <b key={s}>{LEGAL_DOCS[s].title}</b> : <Link key={s} href={`/legal/${s}`}>{LEGAL_DOCS[s].title}</Link>
        ))}
        <Link href="/help">Help Center</Link>
      </nav>
      <article className="kw-doc">{renderMarkdown(src, mapLink)}</article>
    </PublicPage>
  );
}
