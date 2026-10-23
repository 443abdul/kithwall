import 'server-only';
// Server-side helpers for the few route handlers that need the Supabase secret key (spec §1, §7).
// Never import this from a client component.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { b64u, verifyChallenge } from '@kithwall/crypto';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
const BUCKET = 'media';
export const CHALLENGE_TTL_MS = 5 * 60_000;

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

let adminClient: SupabaseClient | null = null;
/** Supabase client with the secret key. Bypasses RLS — use for narrowly-scoped server tasks only. */
export function admin(): SupabaseClient {
  if (!URL_ || !SECRET) throw new Error('SUPABASE_SECRET_KEY is not configured');
  adminClient ??= createClient(URL_, SECRET, noSession);
  return adminClient;
}

/** A client that acts as the signed-in user (RLS and auth.uid() apply). */
export function asUser(jwt: string): SupabaseClient {
  return createClient(URL_, PUBLISHABLE, { ...noSession, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

export interface Caller { user: User; jwt: string; aal: string; sessionId: string | null }

/** Validates the caller's access token with Supabase Auth (also rejects revoked sessions). */
export async function callerFromRequest(req: Request): Promise<Caller | null> {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(h);
  if (!m) return null;
  const jwt = m[1]!;
  const { data, error } = await admin().auth.getUser(jwt);
  if (error || !data.user) return null;
  const claims = decodeJwtPayload(jwt);
  return { user: data.user, jwt, aal: typeof claims.aal === 'string' ? claims.aal : 'aal1', sessionId: typeof claims.session_id === 'string' ? claims.session_id : null };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch { return {}; }
}

/** True when the user has a verified TOTP factor but this session hasn't passed it (aal1). */
export function needsMfa(c: Caller): boolean {
  const verified = (c.user.factors ?? []).some((f) => f.status === 'verified');
  return verified && c.aal !== 'aal2';
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function readJson<T>(req: Request, maxBytes = 16_384): Promise<T | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

export type ChallengePurpose = 'delete_account' | 'delete_all_posts' | 'change_recovery' | 'recover_account' | 'add_credential' | 'rotate_identity' | 'update_bundle';

/**
 * Proof-of-key (spec §3.9): the challenge must belong to the caller, match the purpose, be unused
 * and fresh; the signature must verify against the caller's published identity key. The challenge
 * is then marked used (atomically, so it can't be replayed).
 */
export async function verifyProofOfKey(userId: string, challengeId: string, signature: string, purpose: ChallengePurpose): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/.test(challengeId) || typeof signature !== 'string' || signature.length > 200) return 'Malformed proof.';
  const db = admin();
  const { data: ch } = await db.from('key_challenges').select('id, user_id, nonce, purpose, created_at, used_at').eq('id', challengeId).maybeSingle();
  if (!ch || ch.user_id !== userId || ch.purpose !== purpose) return 'Unknown challenge.';
  if (ch.used_at) return 'This confirmation was already used. Please try again.';
  if (Date.now() - new Date(ch.created_at as string).getTime() > CHALLENGE_TTL_MS) return 'This confirmation expired. Please try again.';
  const { data: prof } = await db.from('profiles').select('sign_pub').eq('id', userId).maybeSingle();
  if (!prof) return 'No identity key on file.';
  let ok = false;
  try { ok = verifyChallenge(b64u.decode(prof.sign_pub as string), ch.nonce as string, signature); } catch { ok = false; }
  if (!ok) return 'Your identity key did not confirm this request.';
  const { data: used } = await db.from('key_challenges').update({ used_at: new Date().toISOString() })
    .eq('id', challengeId).is('used_at', null).select('id');
  if (!used?.length) return 'This confirmation was already used. Please try again.';
  return null;
}

/** Remove every object in the user's media folder (ciphertext blobs), in pages. */
export async function removeStorageFolder(userId: string): Promise<number> {
  const store = admin().storage.from(BUCKET);
  let removed = 0;
  for (let round = 0; round < 1000; round++) {
    const { data, error } = await store.list(userId, { limit: 1000, offset: 0 });
    if (error) throw new Error(`storage list failed: ${error.message}`);
    const paths = (data ?? []).filter((o) => o.name && o.id).map((o) => `${userId}/${o.name}`);
    if (!paths.length) break;
    const rm = await store.remove(paths);
    if (rm.error) throw new Error(`storage remove failed: ${rm.error.message}`);
    removed += paths.length;
  }
  return removed;
}

/** Delete the account for good: storage folder first, then the auth user (cascades every row). */
export async function deleteAccountNow(userId: string): Promise<void> {
  await removeStorageFolder(userId);
  const { error } = await admin().auth.admin.deleteUser(userId, false);
  if (error && !/not.?found/i.test(error.message)) throw new Error(`delete user failed: ${error.message}`);
}

/** Records that a notice email was sent; returns false if it already was. */
export async function claimNotice(kind: 'recovery_started' | 'account_recovered' | 'credential_added' | 'identity_key_changed', refId: string, userId: string): Promise<boolean> {
  const { error } = await admin().from('notice_emails').insert({ kind, ref_id: refId, user_id: userId });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(error.message);
}

/**
 * The site's own origin for links in notices. In production it must be configured: the request's Host
 * header is attacker-controlled on some deployments (security review L8).
 */
export function siteOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_SITE_URL is not set');
  return new URL(req.url).origin;
}
