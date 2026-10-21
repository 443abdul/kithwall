// Kithwall 2 accounts: pure helpers and wire types shared by the browser (passkey-client.ts,
// account-impl.ts) and the route handlers under app/api/auth/passkey (passkey-server.ts).
// No secrets, no I/O. See docs/v2/01-accounts.md.
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { KeyBundle } from '@kithwall/crypto';
import { RESERVED_USERNAMES } from '../social/reserved';

/** Handles are v1 usernames: same rule as the profiles.username check constraint. */
export const HANDLE_RE = /^[a-z0-9][a-z0-9.]{2,29}$/;
const RESERVED = new Set(RESERVED_USERNAMES);

export type HandleProblem = null | 'invalid' | 'taken' | 'reserved';

/** Strips a leading '@', trims and lower-cases. */
export function normalizeHandle(raw: string): string {
  return String(raw ?? '').trim().replace(/^@/, '').toLowerCase();
}

/** Format/reserved check only (no availability). */
export function handleShapeProblem(raw: string): 'invalid' | 'reserved' | null {
  const h = normalizeHandle(raw);
  if (!HANDLE_RE.test(h)) return 'invalid';
  if (RESERVED.has(h)) return 'reserved';
  return null;
}

/**
 * Auth users of passkey-first and passphrase accounts get a synthetic, non-routable address
 * (RFC 2606 `.invalid`), derived from the user id. It is never shown and never mailed.
 */
export const SYNTHETIC_EMAIL_DOMAIN = 'id.kithwall.invalid';

export function syntheticEmailFor(userId: string): string {
  const hex = userId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('bad user id');
  return `u${hex}@${SYNTHETIC_EMAIL_DOMAIN}`;
}

export function isSyntheticEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`);
}

const B64U = /^[A-Za-z0-9_-]+$/;

/** Structural check of a key bundle uploaded at sign-up (the database re-checks it). */
export function bundleLooksValid(b: unknown, opts: { password: boolean }): b is KeyBundle {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const o = b as Record<string, unknown>;
  const str = (k: string, min: number, max: number) => typeof o[k] === 'string' && (o[k] as string).length >= min
    && (o[k] as string).length <= max && B64U.test(o[k] as string);
  if (o.v !== 1) return false;
  const kdf = o.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.alg !== 'argon2id' || kdf.v !== 1 || !Number.isSafeInteger(kdf.m) || !Number.isSafeInteger(kdf.t) || !Number.isSafeInteger(kdf.p)) return false;
  if (!str('signPub', 43, 43) || !str('kxPub', 43, 43) || !str('rkCommitment', 43, 43)) return false;
  if (!str('amkByRecovery', 90, 120) || !str('identityEnc', 120, 160)) return false;
  if (opts.password ? !str('amkByPassword', 90, 120) : o.amkByPassword !== undefined) return false;
  const allowed = new Set(['v', 'kdf', 'signPub', 'kxPub', 'amkByPassword', 'amkByRecovery', 'identityEnc', 'rkCommitment']);
  return Object.keys(o).every((k) => allowed.has(k)) && JSON.stringify(o).length < 4096;
}

export function isB64u(s: unknown, min: number, max: number): s is string {
  return typeof s === 'string' && s.length >= min && s.length <= max && B64U.test(s);
}

/** Passkey labels: plain text, 1–60 characters. */
export function cleanLabel(raw: unknown, fallback = 'Passkey'): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (s || fallback).slice(0, 60);
}

/** Coarse device label made on the device ("Chrome on Android"), never the raw user agent. */
export function deviceLabel(ua: string): string {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : null;
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  if (br && os) return `${br} on ${os}`;
  return br ?? os ?? 'Passkey';
}

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

/** A real address someone can receive notices at (not synthetic, sane shape, ≤ 254 chars). */
export function noticeEmailOk(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email) && !isSyntheticEmail(email) && !/\.invalid$/i.test(email);
}

// ---------------------------------------------------------------------------------------------
// Wire types (JSON bodies of /api/auth/passkey/*). Errors: { error: message, code: AccountErrorCode }.
// ---------------------------------------------------------------------------------------------
export interface RegisterOptionsReq { handle: string; altcha: string; mode: 'passkey' | 'passphrase' }
export interface RegisterOptionsRes {
  challengeId: string;
  userId: string;
  /** passkey mode */
  options?: PublicKeyCredentialCreationOptionsJSON;
  /** passphrase mode: the synthetic address used as the Argon2id salt and auth identifier */
  email?: string;
}
export interface PasskeyWrapIn { prfSalt: string; amkWrap: string }
export interface RegisterVerifyReq {
  challengeId: string;
  bundle: KeyBundle;
  passkey?: { response: RegistrationResponseJSON; label?: string } & PasskeyWrapIn;
  /** passphrase mode: authKey derived on device (becomes the Supabase password) */
  authKey?: string;
}
export interface RegisterVerifyRes { userId: string; email: string; tokenHash?: string }

export interface LoginOptionsRes { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
export interface LoginVerifyReq { challengeId: string; response: AuthenticationResponseJSON }
export interface LoginVerifyRes { userId: string; tokenHash: string; credentialId: string; wrap: PasskeyWrapIn | null }

export interface AddOptionsRes { challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }
/**
 * `keyProof`: signChallenge(identity signing key, addPasskeyNonce(options.challenge)) — proof that the
 * caller holds the unlocked identity key, not just an access token (security review W2).
 */
export interface AddVerifyReq { challengeId: string; response: RegistrationResponseJSON; label?: string; prfSalt: string; amkWrap: string; keyProof: string }
export interface AddVerifyRes { id: string }

export interface LookupReq { handle: string }
export interface LookupRes { email: string }

export interface NoticeEmailReq { email: string | null }
export interface NoticeEmailRes { pending: boolean; sent: boolean }
