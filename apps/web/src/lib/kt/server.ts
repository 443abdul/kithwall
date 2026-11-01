import 'server-only';
// Shared by the /api/kt route handlers (docs/v2/09-key-transparency.md): reading tree heads through the
// anon role (public.kt_head is public data) and the JSON replies.
import { b64u, merkleEmptyRoot } from '@kithwall/crypto';
import { publicClient } from '@/lib/auth/server';
import type { KtHead } from './core';

export function ktReply(status: number, body: unknown, cache: string, cors = true): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      'x-content-type-options': 'nosniff',
      ...(cors ? { 'access-control-allow-origin': '*' } : {}),
    },
  });
}

interface HeadRow { size: number; root: string; created_at: string }

/** The head at `size` (the latest when null); undefined when there is no such head. Throws on errors. */
export async function readHead(size: number | null): Promise<KtHead | undefined> {
  const { data, error } = await publicClient().rpc('kt_head', { p_size: size });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as HeadRow | undefined;
  if (!row) return size === null ? { size: 0, root: b64u.encode(merkleEmptyRoot()), at: null } : undefined;
  return { size: Number(row.size), root: row.root, at: row.created_at };
}

/** A tree size from a query parameter (1 … 2^53 − 1), null when absent, NaN when malformed. */
export function sizeParam(raw: string | null): number | null {
  if (raw === null) return null;
  return /^[1-9]\d{0,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : NaN;
}
