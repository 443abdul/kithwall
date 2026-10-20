import 'server-only';
// Server side of recovery from a @handle (docs/v2/01-accounts.md §3 "Recovering an account").
// The server hands out only what a recovering device needs (the recovery-key wrap of the account
// key, never the passphrase wrap), and mints a session only after the device proves it opened the
// identity key by signing a fresh, single-use nonce.
import type { KeyBundle } from '@kithwall/crypto';
import { admin } from './server';
import { clientIp, ipTag } from './passkey-server';
import { HANDLE_RE, normalizeHandle } from './passkey-shared';

/** Per-instance limiter for the unauthenticated recovery routes (production adds edge limits). */
const hits = new Map<string, { n: number; reset: number }>();
export function tooMany(req: Request, scope: string, max: number, windowMs: number): boolean {
  let tag: string;
  try { tag = ipTag(req); } catch { tag = clientIp(req); }
  const key = `${scope}:${tag}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
  else if (++h.n > max) return true;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return false;
}

export interface Target { userId: string; bundle: KeyBundle }

/** The account behind a handle, with its key bundle. Null when there is none (or no keys yet). */
export async function targetByHandle(raw: unknown): Promise<Target | null | 'invalid'> {
  const handle = normalizeHandle(typeof raw === 'string' ? raw : '');
  if (!HANDLE_RE.test(handle)) return 'invalid';
  const db = admin();
  const { data: prof, error } = await db.from('profiles').select('id').eq('username', handle).maybeSingle();
  if (error) throw new Error(error.message);
  if (!prof) return null;
  const { data: kb, error: e2 } = await db.from('key_bundles').select('bundle').eq('user_id', prof.id).maybeSingle();
  if (e2) throw new Error(e2.message);
  if (!kb?.bundle) return null;
  return { userId: prof.id as string, bundle: kb.bundle as KeyBundle };
}

/** Trusted-friend setup: how many friends, and how many must help. Null when none were chosen. */
export async function trustedSummary(userId: string): Promise<{ count: number; threshold: number } | null> {
  const { data, error } = await admin().from('recovery_shares').select('threshold').eq('owner_id', userId);
  if (error) throw new Error(error.message);
  if (!data?.length) return null;
  return { count: data.length, threshold: Math.min(...data.map((r) => Number(r.threshold))) };
}

/** Recovery challenges issued for an account in the last hour (a per-account limit on top of the IP one). */
export async function recentRecoveryChallenges(userId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error } = await admin().from('key_challenges').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('purpose', 'recover_account').gt('created_at', since);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function issueRecoveryChallenge(userId: string): Promise<{ id: string; nonce: string }> {
  const { data, error } = await admin().from('key_challenges').insert({ user_id: userId, purpose: 'recover_account' })
    .select('id, nonce').single();
  if (error || !data) throw new Error(error?.message ?? 'challenge insert failed');
  return { id: data.id as string, nonce: data.nonce as string };
}
