// Our legal documents (copied from docs/legal into src/content/legal so Vercel, which builds only
// apps/web, ships them). The bodies are English; the page around them is translated.
import type { MessageKey } from '@/i18n';

export const LEGAL_DOCS = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy', label: 'legal.privacy' },
  terms: { file: 'terms-of-service.md', title: 'Terms of Service', label: 'legal.terms' },
  community: { file: 'community-standards.md', title: 'Community Standards', label: 'legal.community' },
  'law-enforcement': { file: 'law-enforcement-guidelines.md', title: 'Law Enforcement Guidelines', label: 'legal.lawEnforcement' },
} as const satisfies Record<string, { file: string; title: string; label: MessageKey }>;

export type LegalSlug = keyof typeof LEGAL_DOCS;
export const LEGAL_SLUGS = Object.keys(LEGAL_DOCS) as LegalSlug[];

export function isLegalSlug(s: string): s is LegalSlug {
  return Object.prototype.hasOwnProperty.call(LEGAL_DOCS, s);
}

const BY_FILE = Object.fromEntries(LEGAL_SLUGS.map((slug) => [LEGAL_DOCS[slug].file, slug])) as Record<string, LegalSlug>;

/** Links between the documents become /legal/... routes; other in-repo links render as plain text. */
export function legalLink(href: string): string | null {
  if (/^https?:\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('#')) return href;
  const [path, hash] = href.split('#');
  const slug = BY_FILE[(path ?? '').replace(/^\.\//, '')];
  return slug ? `/legal/${slug}${hash ? `#${hash}` : ''}` : null;
}
