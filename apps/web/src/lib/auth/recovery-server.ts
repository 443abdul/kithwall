import 'server-only';
// Server side of recovery from a @handle (docs/v2/01-accounts.md §3 "Recovering an account").
// The server hands out only what a recovering device needs (the recovery-key wrap of the account
// key, never the passphrase wrap), and mints a session only after the device proves it opened the
// identity key by signing a fresh, single-use nonce.
import type { KeyBundle } from '@kithwall/crypto';
import { admin } from './server';
import { ipTag } from './passkey-server';
import { clientOverLimit, overLimit, rateKey } from './anon-limit';
import { parsePayload, verifyPayload } from './altcha-server';
import { HANDLE_RE, normalizeHandle } from './passkey-shared';

/**
 * Rate limit for the unauthenticated recovery routes, per client (daily IP tag), shared by every
 * instance through the database (security review L6/W4; lib/auth/anon-limit.ts).
 */
export function tooMany(req: Request, scope: string, max: number, windowMs: number): Promise<boolean> {
  return clientOverLimit(req, scope, max, Math.ceil(windowMs / 1000));
}

/**
 * Per-account limit on recovery-key challenges (security review W4): at most 12 an hour for one account
 * from one client (an IPv4 address or IPv6 /64, see ipBucket). There is deliberately NO account-wide
 * limit (security re-review R-W4): strangers could use it up and lock the owner out of their own
 * recovery, and a nonce is worthless without the recovery key. Each lookup also costs a proof-of-work.
 */
export async function accountTooMany(req: Request, userId: string): Promise<boolean> {
  return overLimit(rateKey('recover-account-target-client', userId, ipTag(req)), 12, 3600);
}

/** A valid, unexpired, unused ALTCHA proof-of-work (spent here, so it can't be replayed). */
export async function proofOfWorkOk(raw: unknown): Promise<boolean> {
  const pow = parsePayload(raw);
  if (!pow || !(await verifyPayload(pow))) return false;
  const spent = await admin().from('altcha_spent').insert({ signature: pow.challenge.signature });
  if (spent.error) {
    if (spent.error.code === '23505') return false;
    throw new Error(spent.error.message);
  }
  return true;
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

export async function issueRecoveryChallenge(userId: string): Promise<{ id: string; nonce: string }> {
  const { data, error } = await admin().from('key_challenges').insert({ user_id: userId, purpose: 'recover_account' })
    .select('id, nonce').single();
  if (error || !data) throw new Error(error?.message ?? 'challenge insert failed');
  return { id: data.id as string, nonce: data.nonce as string };
}
