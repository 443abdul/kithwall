// POST /api/account/bundle (Bearer) — { challengeId, signature, bundle } → { ok }.
// Security re-review R-K-5: clients can no longer write public.key_bundles directly, because a stolen
// session token alone could overwrite (destroy) the wrapped keys and lock the owner out. Password /
// passphrase changes and new recovery keys come through here instead, with:
//   * a fresh single-use proof-of-key (purpose 'update_bundle') signed with the CURRENT identity key,
//   * aal2 when the account has an authenticator app,
//   * a bundle that keeps the identity exactly (signPub, kxPub, identityEnc, version): only the wraps of
//     the account key (amkByPassword, amkByRecovery), the recovery commitment and the KDF settings change
//     (prevKxEnc, the earlier key-exchange keys, stays too).
// Identity-key rotation has its own route (../identity-key).
import type { KeyBundle } from '@kithwall/crypto';
import { admin, callerFromRequest, json, needsMfa, readJson, verifyProofOfKey } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

interface Body { challengeId?: string; signature?: string; bundle?: KeyBundle }
const FIXED = ['v', 'signPub', 'kxPub', 'identityEnc', 'prevKxEnc'] as const;
const MUTABLE = new Set(['kdf', 'amkByPassword', 'amkByRecovery', 'rkCommitment']);
const B64U = /^[A-Za-z0-9_-]{20,200}$/;

function sameJson(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please sign in again.' }, 401);
  if (needsMfa(caller)) return json({ error: 'Enter your authenticator code first.' }, 403);
  const body = await readJson<Body>(req, 16_384);
  const next = body?.bundle as unknown as Record<string, unknown> | undefined;
  if (!body || !next || typeof next !== 'object' || Array.isArray(next) || JSON.stringify(next).length >= 8000) {
    return json({ error: 'Bad request.' }, 400);
  }
  const userId = caller.user.id;
  const db = admin();
  const { data: row } = await db.from('key_bundles').select('bundle').eq('user_id', userId).maybeSingle();
  const cur = row?.bundle as Record<string, unknown> | undefined;
  if (!cur) return json({ error: 'Finish setting up your account first.' }, 409);
  const keysOk = Object.keys(next).every((k) => (FIXED as readonly string[]).includes(k) || MUTABLE.has(k))
    && FIXED.every((k) => sameJson(next[k], cur[k]))
    && ['amkByRecovery', 'rkCommitment'].every((k) => typeof next[k] === 'string' && B64U.test(next[k] as string))
    && (next.amkByPassword === undefined || (typeof next.amkByPassword === 'string' && B64U.test(next.amkByPassword)))
    && (cur.amkByPassword === undefined || next.amkByPassword !== undefined)   // a passphrase is never silently dropped
    && typeof next.kdf === 'object' && next.kdf !== null && !Array.isArray(next.kdf) && JSON.stringify(next.kdf).length < 200;
  if (!keysOk) return json({ error: 'This change would alter your identity keys.' }, 400);
  const problem = await verifyProofOfKey(userId, String(body.challengeId ?? ''), String(body.signature ?? ''), 'update_bundle');
  if (problem) return json({ error: problem }, 403);
  const { error } = await db.from('key_bundles').update({ bundle: next, updated_at: new Date().toISOString() }).eq('user_id', userId);
  if (error) {
    console.error('bundle update', error.message);
    return json({ error: 'Please try again.' }, 503);
  }
  return json({ ok: true });
}
