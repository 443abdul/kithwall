import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderMarkdown } from '@/components/auth/Markdown';
import { LegalScreen } from '@/components/public/LegalScreen';
import { LEGAL_DOCS, isLegalSlug, legalLink, type LegalSlug } from '@/components/public/legal';

/** Each document is read with a literal path, so output file tracing ships it. */
function read(slug: LegalSlug): Promise<string> {
  const dir = join(process.cwd(), 'src/content/legal');
  switch (slug) {
    case 'privacy': return readFile(join(dir, 'privacy-policy.md'), 'utf8');
    case 'terms': return readFile(join(dir, 'terms-of-service.md'), 'utf8');
    case 'community': return readFile(join(dir, 'community-standards.md'), 'utf8');
    case 'law-enforcement': return readFile(join(dir, 'law-enforcement-guidelines.md'), 'utf8');
  }
}

export async function generateMetadata({ params }: PageProps<'/legal/[doc]'>): Promise<Metadata> {
  const { doc } = await params;
  return { title: isLegalSlug(doc) ? LEGAL_DOCS[doc].title : 'Legal' };
}

export default async function Page({ params }: PageProps<'/legal/[doc]'>) {
  const { doc } = await params;
  if (!isLegalSlug(doc)) notFound();
  const src = await read(doc);
  return <LegalScreen slug={doc}>{renderMarkdown(src, legalLink)}</LegalScreen>;
}
