import 'server-only';
// Server side of Kithwall 2 accounts (docs/v2/01-accounts.md): relying-party config, the
// single-use challenge store, per-client rate limits, synthetic auth users and session minting.
// The server verifies WebAuthn ceremonies and stores credential public keys; it never sees a PRF
// output, a passphrase or the account master key.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AccountErrorCode } from './account';
import { admin, json } from './server';
import { isSyntheticEmail, syntheticEmailFor } from './passkey-shared';
import { ipBucket } from './ip-bucket';
import { androidOrigins, parseCertFingerprints } from '../native/association';

export const RP_NAME = 'Kithwall';
const CHALLENGE_TTL_S = 5 * 60;

// ---------------------------------------------------------------------------------------------
// Relying party
// ---------------------------------------------------------------------------------------------
export interface RelyingParty { rpID: string; origins: string[] }

/**
 * rpID and accepted origins, in order of precedence:
 *  1. PASSKEY_RP_ID (+ optional comma-separated PASSKEY_ORIGINS, default https://<rpID>),
 *  2. the host of NEXT_PUBLIC_SITE_URL (origin = that URL's origin),
 *  3. outside production only: the request's own host when it is localhost / *.localhost
 *     (WebAuthn does not allow IP addresses such as 127.0.0.1 as an rpID).
 * Returns null when no relying party is configured for this request.
 *
 * The Android app (docs/v2/05-native.md §2) signs with the same rpID through Credential Manager, whose
 * clientDataJSON origin is `android:apk-key-hash:<cert hash>` rather than the web origin: those origins
 * are accepted for every signing certificate listed in ANDROID_CERT_SHA256 (the same list that
 * /.well-known/assetlinks.json publishes). iOS reports https://<rpID>, which is already accepted.
 */
export function relyingParty(req: Request): RelyingParty | null {
  const rp = webRelyingParty(req);
  if (!rp) return null;
  const apps = androidOrigins(parseCertFingerprints(process.env.ANDROID_CERT_SHA256));
  return apps.length ? { rpID: rp.rpID, origins: [...rp.origins, ...apps] } : rp;
}

function webRelyingParty(req: Request): RelyingParty | null {
  const envRp = (process.env.PASSKEY_RP_ID || process.env.NEXT_PUBLIC_PASSKEY_RP_ID)?.trim();
  if (envRp) {
    const origins = (process.env.PASSKEY_ORIGINS ?? `https://${envRp}`).split(',').map((s) => s.trim()).filter(Boolean);
    return { rpID: envRp, origins };
  }
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) {
    try {
      const u = new URL(site);
      const origins = [u.origin];
      // kithwall.com and www.kithwall.com share the registrable domain, so both may use rpID = host.
      if (!u.hostname.startsWith('www.')) origins.push(`${u.protocol}//www.${u.host}`);
      return { rpID: u.hostname, origins };
    } catch { /* fall through */ }
  }
  if (process.env.NODE_ENV === 'production') return null;
  const host = new URL(req.url).host;   // includes the port
  const hostname = host.replace(/:\d+$/, '');
  if (hostname !== 'localhost' && !hostname.endsWith('.localhost')) return null;
  return { rpID: hostname, origins: [`http://${host}`, `https://${host}`] };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
export function fail(code: AccountErrorCode, status: number, message?: string): Response {
  return json({ error: message ?? code, code }, status);
}

// ---------------------------------------------------------------------------------------------
// Client tag for unauthenticated rate limits: HMAC of the client IP with a key that changes every
// day, truncated. It is stored only on challenge rows (deleted within the hour after expiry).
// ---------------------------------------------------------------------------------------------
function tagKey(): string {
  const base = process.env.ALTCHA_HMAC_KEY ?? process.env.SUPABASE_SECRET_KEY ?? '';
  if (base.length < 16) throw new Error('ALTCHA_HMAC_KEY is not configured');
  return createHmac('sha256', base).update('kithwall/passkey/ip-tag').digest('hex');
}

/**
 * The client address as seen by the nearest proxy we trust (security review L6). Proxies APPEND to
 * X-Forwarded-For, so the leftmost entries are whatever the client sent; we count TRUSTED_PROXY_HOPS
 * (default 1: Vercel, or one nginx/Caddy in front of a self-hosted server) from the right. On Vercel the
 * platform's own x-real-ip is used when present.
 */
export function clientIp(req: Request, hops = trustedHops()): string {
  if (process.env.VERCEL) {
    const real = req.headers.get('x-real-ip')?.trim();
    if (real) return real;
  }
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fwd = chain.length ? chain[Math.max(0, chain.length - hops)] : '';
  return fwd || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

function trustedHops(): number {
  const n = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1;
}

export function ipTag(req: Request): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHmac('sha256', tagKey()).update(`${day}\n${ipBucket(clientIp(req))}`).digest('hex').slice(0, 32);
}

/** Per-client limits for unauthenticated ceremonies, counted from the challenge store. */
export const LIMITS = {
  register: { max: 10, seconds: 3600 },
  register_passphrase: { max: 10, seconds: 3600 },
  login: { max: 60, seconds: 600 },
  add: { max: 20, seconds: 3600 },
} as const;
export type Intent = keyof typeof LIMITS;

export async function rateLimited(tag: string, intent: Intent): Promise<boolean> {
  const { max, seconds } = LIMITS[intent];
  const { data, error } = await admin().rpc('webauthn_recent_challenges', { p_ip_tag: tag, p_intent: intent, p_seconds: seconds });
  if (error) throw new Error(error.message);
  return typeof data === 'number' && data >= max;
}

// ---------------------------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------------------------
export interface ChallengeRow {
  id: string; intent: Intent; challenge: string; user_id: string | null; new_user_id: string | null;
  handle: string | null; webauthn_user_id: string | null; created_at: string; expires_at: string; used_at: string | null;
}

export function newChallengeBytes(): string {
  return isoBase64URL.fromBuffer(new Uint8Array(randomBytes(32)));
}

export async function storeChallenge(row: {
  intent: Intent; challenge: string; tag: string; userId?: string; newUserId?: string; handle?: string; webauthnUserId?: string;
}): Promise<string> {
  const db = admin();
  const { data, error } = await db.from('webauthn_challenges').insert({
    intent: row.intent, challenge: row.challenge, ip_tag: row.tag, user_id: row.userId ?? null,
    new_user_id: row.newUserId ?? null, handle: row.handle ?? null, webauthn_user_id: row.webauthnUserId ?? null,
    expires_at: new Date(Date.now() + CHALLENGE_TTL_S * 1000).toISOString(),
  }).select('id').single();
  if (error || !data) throw new Error(error?.message ?? 'challenge insert failed');
  // Opportunistic cleanup (the hourly job also does this).
  void db.from('webauthn_challenges').delete().lt('expires_at', new Date(Date.now() - 3600_000).toISOString()).then(() => undefined);
  return data.id as string;
}

/** Single use: marks the challenge used. Null when unknown, used, expired or for another intent. */
export async function consumeChallenge(id: unknown, intent: Intent): Promise<ChallengeRow | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data, error } = await admin().rpc('consume_webauthn_challenge', { p_id: id, p_intent: intent });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ChallengeRow[];
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Users and sessions
// ---------------------------------------------------------------------------------------------

/** Creates the auth user (no hook runs for admin creation, so the caller has checked ALTCHA). */
export async function createAuthUser(userId: string, password?: string): Promise<string> {
  const email = syntheticEmailFor(userId);
  const { error } = await admin().auth.admin.createUser({
    // Passkey accounts get a random password nobody knows (security re-review R-W3): GoTrue's password grant
    // then runs bcrypt for every synthetic account, so its timing can't tell passphrase accounts apart.
    id: userId, email, email_confirm: true, password: password ?? randomBytes(32).toString('base64url'),
    app_metadata: { kw_account: password ? 'passphrase' : 'passkey' },
  });
  if (error) throw new Error(error.message);
  return email;
}

export async function deleteAuthUser(userId: string): Promise<void> {
  await admin().auth.admin.deleteUser(userId, false).catch(() => undefined);
}

/**
 * Mints a sign-in for an existing user without sending anything: an admin magic-link token whose
 * hash the browser redeems with verifyOtp({ token_hash, type: 'magiclink' }). Single use, and it
 * expires with the auth OTP expiry (1 h by default). Only ever returned after a verified passkey.
 */
export async function mintSessionToken(userId: string): Promise<string> {
  const db = admin();
  const { data: u, error: ue } = await db.auth.admin.getUserById(userId);
  if (ue || !u.user?.email) throw new Error('user has no address');
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  const hash = data?.properties?.hashed_token;
  if (error || !hash) throw new Error(error?.message ?? 'could not mint a session');
  return hash;
}

export async function signupsEnabled(): Promise<boolean> {
  const { data } = await admin().from('app_settings').select('value').eq('key', 'signups_enabled').maybeSingle();
  return data?.value !== false;
}

/** Profile handle taken (case-insensitive: profiles.username is citext). */
export async function handleTaken(handle: string): Promise<boolean> {
  const { data, error } = await admin().from('profiles').select('id').eq('username', handle).maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

export function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(isoBase64URL.toBuffer(s));
}
export function bytesToB64u(b: Uint8Array): string {
  return isoBase64URL.fromBuffer(new Uint8Array(b));
}

/** SHA-256 hex (verification-link tokens are stored hashed). */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// Ceremony verification
// ---------------------------------------------------------------------------------------------
export interface NewPasskey { credentialId: string; publicKey: string; counter: number; transports: string[]; backedUp: boolean }

const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

/** Verifies a registration response against a consumed challenge (user verification required). */
export async function verifyNewPasskey(rp: RelyingParty, expectedChallenge: string, response: unknown): Promise<NewPasskey | null> {
  if (!response || typeof response !== 'object') return null;
  // The PRF output must never reach us; refuse responses that carry one (a client bug).
  const ext = (response as { clientExtensionResults?: { prf?: { results?: unknown } } }).clientExtensionResults;
  if (ext?.prf?.results) return null;
  try {
    const v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    return {
      credentialId: c.id, publicKey: bytesToB64u(c.publicKey), counter: c.counter,
      transports: (c.transports ?? []).filter((t) => TRANSPORTS.has(t)).slice(0, 8),
      backedUp: v.registrationInfo.credentialBackedUp,
    };
  } catch (e) {
    console.warn('passkey registration rejected:', (e as Error).message);
    return null;
  }
}

export interface StoredPasskey {
  id: string; user_id: string; credential_id: string; public_key: string; counter: number; transports: string[];
}

/** Verifies an assertion for a stored credential; returns the new counter state or null. */
export async function verifyAssertion(rp: RelyingParty, expectedChallenge: string, response: AuthenticationResponseJSON, cred: StoredPasskey) {
  const ext = (response as { clientExtensionResults?: { prf?: { results?: unknown } } }).clientExtensionResults;
  if (ext?.prf?.results) return null;
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: {
        id: cred.credential_id, publicKey: b64uToBytes(cred.public_key), counter: Number(cred.counter),
        transports: cred.transports as AuthenticatorTransportFuture[],
      },
    });
    if (!v.verified) return null;
    return { newCounter: v.authenticationInfo.newCounter, backedUp: v.authenticationInfo.credentialBackedUp };
  } catch (e) {
    console.warn('passkey assertion rejected:', (e as Error).message);
    return null;
  }
}

/**
 * Where to send content-free account notices: the verified notice address if the person set one,
 * otherwise their auth email unless it is a synthetic passkey-account address. Null = nowhere.
 */
export async function noticeAddress(userId: string, authEmail: string | null | undefined): Promise<string | null> {
  const { data } = await admin().from('account_security').select('notice_email, notice_email_verified_at')
    .eq('user_id', userId).maybeSingle();
  if (data?.notice_email && data.notice_email_verified_at) return data.notice_email as string;
  return authEmail && !isSyntheticEmail(authEmail) ? authEmail : null;
}
