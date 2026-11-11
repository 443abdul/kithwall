import type { Metadata } from 'next';
import { PublicPostScreen } from '@/components/public/PublicPostScreen';

// The shareable link of a PUBLIC post (docs/v2/10-follow-public.md §4): opens read-only, with or without an
// account. Search engines are told to stay away unless the post's author turned on "Let search engines show
// my public posts"; the answer comes from the same database function the page itself reads, asked with the
// app's public key (nothing here uses a privileged key, and nothing about the visitor is recorded).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOINDEX = { index: false, follow: false } as const;

async function publicFacts(id: string): Promise<{ handle: string; name: string | null; indexable: boolean } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/public_post`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(4000),
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_id: id }),
    });
    if (!res.ok) return null;
    const rows = await res.json() as { author_username?: unknown; author_name?: unknown; indexable?: unknown }[];
    const r = Array.isArray(rows) ? rows[0] : null;
    if (!r || typeof r.author_username !== 'string') return null;
    return { handle: r.author_username, name: typeof r.author_name === 'string' ? r.author_name : null, indexable: r.indexable === true };
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps<'/p/[id]'>): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: 'Post', robots: NOINDEX };
  const facts = await publicFacts(id);
  if (!facts) return { title: 'Post', robots: NOINDEX };
  return {
    title: `${facts.name?.trim() || `@${facts.handle}`} on Kithwall`,
    robots: facts.indexable ? { index: true, follow: false } : NOINDEX,
    ...(facts.indexable ? { alternates: { canonical: `/p/${id.toLowerCase()}` } } : {}),
  };
}

export default async function Page({ params }: PageProps<'/p/[id]'>) {
  const { id } = await params;
  return <PublicPostScreen key={id} id={id.slice(0, 64)} />;
}
