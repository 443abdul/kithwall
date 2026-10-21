// POST /api/account/identity-key (Bearer) — signed identity-key rotation (security review K2).
//   { challengeId, signature, change: { userId, newSignPub, newKxPub, at }, sig, bundle }
// The identity columns of public.profiles are immutable except through public.apply_identity_key_change,
// which only the service role may call. Before calling it this route checks that the request comes from a
// device holding the CURRENT identity key:
//   * a fresh single-use proof-of-key nonce (purpose 'rotate_identity') signed with the current key,
//   * the key-change statement signed with the current key (contacts verify the same signature from
//     public.key_changes before they trust the new key),
//   * aal2 when the account has an authenticator app,
// and that the new bundle carries exactly the new public keys. A session token alone (email takeover,
// stolen refresh token) can no longer replace anyone's keys. Every device and the notice address are told.
import { b64u, verifyKeyChange, type KeyBundle, type KeyChange } from '@kithwall/crypto';
import { admin, callerFromRequest, json, needsMfa, readJson, verifyProofOfKey } from '@/lib/auth/server';
import { noticeSecurityChange } from '@/lib/auth/credentials-server';

export const dynamic = 'force-dynamic';

interface Body { challengeId?: string; signature?: string; change?: KeyChange; sig?: string; bundle?: KeyBundle }
const KEY = /^[A-Za-z0-9_-]{43}$/;

export async function POST(req: Request) {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'Please sign in again.' }, 401);
  if (needsMfa(caller)) return json({ error: 'Enter your authenticator code first.' }, 403);
  const body = await readJson<Body>(req, 32_768);
  const userId = caller.user.id;
  const c = body?.change;
  if (!body || !c || typeof c !== 'object' || c.userId !== userId || !KEY.test(String(c.newSignPub)) || !KEY.test(String(c.newKxPub))
      || typeof c.at !== 'string' || Math.abs(Date.now() - Date.parse(c.at)) > 10 * 60_000
      || typeof body.sig !== 'string' || !body.bundle || typeof body.bundle !== 'object'
      || body.bundle.signPub !== c.newSignPub || body.bundle.kxPub !== c.newKxPub) {
    return json({ error: 'Bad request.' }, 400);
  }
  const db = admin();
  const { data: prof } = await db.from('profiles').select('sign_pub').eq('id', userId).maybeSingle();
  if (!prof) return json({ error: 'Finish setting up your account first.' }, 409);
  const problem = await verifyProofOfKey(userId, String(body.challengeId ?? ''), String(body.signature ?? ''), 'rotate_identity');
  if (problem) return json({ error: problem }, 403);
  let signed = false;
  try { signed = verifyKeyChange(b64u.decode(prof.sign_pub as string), c, body.sig); } catch { signed = false; }
  if (!signed) return json({ error: 'The key change must be signed with your current identity key.' }, 403);

  const change = { userId, newSignPub: c.newSignPub, newKxPub: c.newKxPub, at: c.at, oldSignPub: prof.sign_pub as string };
  const { data, error } = await db.rpc('apply_identity_key_change', { p_user: userId, p_change: change, p_sig: body.sig, p_bundle: body.bundle });
  if (error) {
    if (error.code === 'P0429') return json({ error: 'Too many key changes today.' }, 429);
    if (error.code === '40001') return json({ error: 'Your key changed in the meantime. Please try again.' }, 409);
    if (error.code === '22023') return json({ error: 'Bad request.' }, 400);
    console.error('identity key change', error.message);
    return json({ error: 'Please try again.' }, 503);
  }
  await noticeSecurityChange(req, userId, 'identity', String(body.challengeId), caller.user.email);
  return json({ keyVersion: data as number });
}
