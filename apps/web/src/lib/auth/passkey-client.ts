'use client';
// Browser side of passkey ceremonies with the WebAuthn PRF extension (docs/v2/01-accounts.md).
// Every ceremony asks for PRF(credential, PRF_APP_SALT); the 32-byte output stays in this tab and is
// stripped from the response before anything is sent to the server.
// Inside the Kithwall app (lib/native) the same ceremonies run through the platform's native passkey API
// instead of the WebView (docs/v2/05-native.md §3): same rpID, same PRF input, same return shapes.
import {
  WebAuthnAbortService, browserSupportsWebAuthn, startAuthentication, startRegistration,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { PRF_APP_SALT } from '@kithwall/crypto';
import { AccountError, type AccountErrorCode } from './account';
import { isNative } from '../native';

const nativePasskey = () => import('../native/passkey');

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
export async function api<T>(path: string, body: unknown, token?: string, method: 'POST' | 'GET' = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, cache: 'no-store',
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch {
    throw new AccountError('network', 'Network problem. Check your connection and try again.');
  }
  let out: unknown = null;
  try { out = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = out as { error?: string; code?: AccountErrorCode } | null;
    throw new AccountError(e?.code ?? (res.status === 429 ? 'rate_limited' : 'unknown'), e?.error ?? `Request failed (${res.status})`);
  }
  return out as T;
}

// ---------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------
export function webauthnAvailable(): boolean {
  // The apps require Android 9 / iOS 16, where the platform passkey API always exists.
  if (isNative()) return true;
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

/** true/false when the browser can tell (getClientCapabilities), otherwise 'unknown'. */
export async function prfSupport(): Promise<boolean | 'unknown'> {
  if (isNative()) return (await (await nativePasskey()).nativePasskeyAvailable()).prf;
  if (!webauthnAvailable()) return false;
  const PKC = window.PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  if (typeof PKC.getClientCapabilities !== 'function') return 'unknown';
  try {
    const caps = await PKC.getClientCapabilities();
    const v = caps['extension:prf'];
    return typeof v === 'boolean' ? v : 'unknown';
  } catch { return 'unknown'; }
}

// ---------------------------------------------------------------------------------------------
// Ceremonies
// ---------------------------------------------------------------------------------------------
type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } };

function prfInput() {
  // simplewebauthn passes `extensions` through to navigator.credentials unchanged, so BufferSource works.
  return { prf: { eval: { first: PRF_APP_SALT as BufferSource } } } as unknown as AuthenticationExtensionsClientInputs;
}

function takePrf(resp: { clientExtensionResults: AuthenticationExtensionsClientOutputs }): { output: Uint8Array | null; enabled: boolean } {
  const ext = resp.clientExtensionResults as { prf?: PrfResults };
  const first = ext.prf?.results?.first;
  const output = first
    ? new Uint8Array(ArrayBuffer.isView(first) ? first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) : first.slice(0))
    : null;
  const enabled = !!ext.prf?.enabled || !!output;
  // Never send the PRF output (or anything derived from it) to the server.
  if (ext.prf) delete ext.prf.results;
  return { output, enabled };
}

function mapWebAuthnError(e: unknown): AccountError {
  if (e instanceof AccountError) return e;
  const err = e as { name?: string; code?: string; cause?: { name?: string } };
  const name = err.cause?.name ?? err.name;
  if (err.code === 'ERROR_CEREMONY_ABORTED' || name === 'NotAllowedError' || name === 'AbortError') {
    return new AccountError('passkey_cancelled', 'The passkey prompt was closed.');
  }
  if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return new AccountError('unknown', 'This device already has a passkey for this account.');
  }
  if (name === 'NotSupportedError' || name === 'SecurityError' || /not supported/i.test(String((e as Error)?.message))) {
    return new AccountError('passkey_unsupported', 'Passkeys are not available here.');
  }
  return new AccountError('unknown', (e as Error)?.message ?? 'Passkey error');
}

export interface CreatedPasskey { response: RegistrationResponseJSON; credentialId: string; prf: Uint8Array }

/**
 * navigator.credentials.create() with PRF. Some authenticators only report `prf.enabled` at
 * creation; then one immediate get() on the new credential evaluates the PRF (a second prompt).
 * Throws prf_unsupported if the passkey was made but cannot do PRF (it stays unregistered).
 */
export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON, displayName?: string): Promise<CreatedPasskey> {
  if (!webauthnAvailable()) throw new AccountError('passkey_unsupported');
  // The person's name stays on the device (the server only ever saw the handle).
  const user = { ...options.user, displayName: displayName?.trim() || options.user.displayName };
  if (isNative()) {
    const made = await (await nativePasskey()).nativeCreate({ ...options, user }, PRF_APP_SALT);
    let out = made.prf;
    if (!out && made.enabled) {
      out = (await evaluatePrf(options.rp.id ?? location.hostname, [{ id: made.response.id, transports: made.response.response.transports }]))?.output ?? null;
    }
    if (!out) throw new AccountError('prf_unsupported', 'This passkey can\'t protect your keys on this device.');
    return { response: made.response, credentialId: made.response.id, prf: out };
  }
  const opts: PublicKeyCredentialCreationOptionsJSON = {
    ...options, user,
    extensions: { ...(options.extensions ?? {}), ...prfInput() } as PublicKeyCredentialCreationOptionsJSON['extensions'],
  };
  let response: RegistrationResponseJSON;
  try {
    response = await startRegistration({ optionsJSON: opts });
  } catch (e) { throw mapWebAuthnError(e); }
  const took = takePrf(response);
  let output = took.output;
  const enabled = took.enabled;
  if (!output && enabled) {
    output = (await evaluatePrf(options.rp.id ?? location.hostname, [{ id: response.id, transports: response.response.transports }]))?.output ?? null;
  }
  if (!output) throw new AccountError('prf_unsupported', 'This passkey can\'t protect your keys on this device.');
  return { response, credentialId: response.id, prf: output };
}

/** A local-only assertion just to evaluate the PRF of known credentials (nothing is sent anywhere). */
export async function evaluatePrf(
  rpId: string, allow: { id: string; transports?: string[] }[],
): Promise<{ output: Uint8Array; credentialId: string } | null> {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  const optionsJSON: PublicKeyCredentialRequestOptionsJSON = {
    rpId, challenge: b64url(challenge), userVerification: 'required', timeout: 120_000,
    allowCredentials: allow.map((c) => ({ id: c.id, type: 'public-key', transports: c.transports as never })),
    extensions: prfInput() as PublicKeyCredentialRequestOptionsJSON['extensions'],
  };
  if (isNative()) {
    const r = await (await nativePasskey()).nativeGet({ ...optionsJSON, extensions: {} }, PRF_APP_SALT);
    return r.prf ? { output: r.prf, credentialId: r.response.id } : null;
  }
  let resp: AuthenticationResponseJSON;
  try {
    resp = await startAuthentication({ optionsJSON });
  } catch (e) { throw mapWebAuthnError(e); }
  const { output } = takePrf(resp);
  return output ? { output, credentialId: resp.id } : null;
}

export interface Assertion { response: AuthenticationResponseJSON; credentialId: string; prf: Uint8Array | null }

/** Discoverable-credential assertion (no allow-list) with PRF. */
export async function getPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<Assertion> {
  if (!webauthnAvailable()) throw new AccountError('passkey_unsupported');
  if (isNative()) {
    const r = await (await nativePasskey()).nativeGet(options, PRF_APP_SALT);
    return { response: r.response, credentialId: r.response.id, prf: r.prf };
  }
  const opts: PublicKeyCredentialRequestOptionsJSON = {
    ...options, extensions: { ...(options.extensions ?? {}), ...prfInput() } as PublicKeyCredentialRequestOptionsJSON['extensions'],
  };
  let response: AuthenticationResponseJSON;
  try {
    response = await startAuthentication({ optionsJSON: opts });
  } catch (e) { throw mapWebAuthnError(e); }
  const { output } = takePrf(response);
  return { response, credentialId: response.id, prf: output };
}

export function cancelCeremony() {
  if (isNative()) return;   // the native sheet is dismissed by the person
  try { WebAuthnAbortService.cancelCeremony(); } catch { /* none running */ }
}

function b64url(b: Uint8Array): string {
  let s = '';
  b.forEach((x) => { s += String.fromCharCode(x); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The rpId the server registers passkeys under (see relyingParty() in passkey-server.ts): the
 * NEXT_PUBLIC_PASSKEY_RP_ID / NEXT_PUBLIC_SITE_URL host when this page is on it (or a subdomain),
 * else this page's hostname (local development).
 */
export function clientRpId(): string {
  const here = location.hostname;
  let configured = process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim() || '';
  if (!configured && process.env.NEXT_PUBLIC_SITE_URL) {
    try { configured = new URL(process.env.NEXT_PUBLIC_SITE_URL).hostname; } catch { /* ignore */ }
  }
  if (configured && (here === configured || here.endsWith(`.${configured}`))) return configured;
  return here;
}
