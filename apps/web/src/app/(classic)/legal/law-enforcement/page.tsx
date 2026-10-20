import type { Metadata } from 'next';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LegalDoc } from '@/components/auth/LegalDoc';

export const metadata: Metadata = { title: 'Law Enforcement Guidelines' };

export default async function Page() {
  const src = await readFile(join(process.cwd(), 'src/content/legal/law-enforcement-guidelines.md'), 'utf8');
  return <LegalDoc slug="law-enforcement" src={src} />;
}
