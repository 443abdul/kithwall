'use client';
// Passkey ceremonies inside the Kithwall app (docs/v2/05-native.md §3). WebViews don't offer WebAuthn
// with PRF, so the app asks the platform directly: Android Credential Manager / iOS AuthenticationServices,
// with the SAME rpID as the website, so a person's synced passkey works in both and the PRF output (and
// therefore the AMK wrap) is identical. The results are converted to the shapes @simplewebauthn/browser
// returns, so lib/auth/passkey-client.ts and the server don't care where they came from.
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { AccountError } from '../auth/account';
import { nativeErrorCode, nativePlugin } from './index';

type Json = Record<string, unknown>;

export function b64urlEncode(b: Uint8Array): string {
  let s = '';
  b.forEach((x) => { s += String.fromCharCode(x); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Normalise any base64 / base64url string (padding, alphabet) to unpadded base64url. */
const norm = (v: unknown): string => (typeof v === 'string' ? v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

/** PRF extension input for the native request JSON (binary values are base64url there). */
export function prfExtension(salt: Uint8Array) {
  return { prf: { eval: { first: b64urlEncode(salt) } } };
}

/** Take the PRF output out of a native response (it never goes to the server). */
export function extractPrf(resp: Json): { output: Uint8Array | null; enabled: boolean } {
  const ext = (resp.clientExtensionResults ?? {}) as { prf?: { enabled?: boolean; results?: { first?: unknown } } };
  const first = ext.prf?.results?.first;
  const output = typeof first === 'string' && first ? b64urlDecode(norm(first)) : null;
  const enabled = !!ext.prf?.enabled || !!output;
  if (ext.prf) delete ext.prf.results;
  return { output, enabled };
}

function mapError(e: unknown): AccountError {
  switch (nativeErrorCode(e)) {
    case 'cancelled': return new AccountError('passkey_cancelled', 'The passkey prompt was closed.');
    case 'no_credential': return new AccountError('passkey_cancelled', 'No passkey for Kithwall was found on this device.');
    case 'exists': return new AccountError('unknown', 'This device already has a passkey for this account.');
    case 'unsupported': return new AccountError('passkey_unsupported', 'Passkeys are not available on this device.');
    default: return new AccountError('unknown', (e as Error)?.message ?? 'Passkey error');
  }
}

/** The registration response in @simplewebauthn's JSON shape (unpadded base64url everywhere). */
export function toRegistrationJSON(r: Json): RegistrationResponseJSON {
  const resp = (r.response ?? {}) as Json;
  return {
    id: norm(r.id), rawId: norm(r.rawId ?? r.id), type: 'public-key',
    response: {
      clientDataJSON: norm(resp.clientDataJSON), attestationObject: norm(resp.attestationObject),
      ...(Array.isArray(resp.transports) ? { transports: resp.transports as RegistrationResponseJSON['response']['transports'] } : {}),
      ...(typeof resp.authenticatorData === 'string' ? { authenticatorData: norm(resp.authenticatorData) } : {}),
      ...(typeof resp.publicKey === 'string' ? { publicKey: norm(resp.publicKey) } : {}),
      ...(typeof resp.publicKeyAlgorithm === 'number' ? { publicKeyAlgorithm: resp.publicKeyAlgorithm } : {}),
    },
    clientExtensionResults: (r.clientExtensionResults ?? {}) as RegistrationResponseJSON['clientExtensionResults'],
    ...(r.authenticatorAttachment === 'platform' || r.authenticatorAttachment === 'cross-platform' ? { authenticatorAttachment: r.authenticatorAttachment } : {}),
  };
}

export function toAuthenticationJSON(r: Json): AuthenticationResponseJSON {
  const resp = (r.response ?? {}) as Json;
  return {
    id: norm(r.id), rawId: norm(r.rawId ?? r.id), type: 'public-key',
    response: {
      clientDataJSON: norm(resp.clientDataJSON), authenticatorData: norm(resp.authenticatorData), signature: norm(resp.signature),
      ...(typeof resp.userHandle === 'string' && resp.userHandle ? { userHandle: norm(resp.userHandle) } : {}),
    },
    clientExtensionResults: (r.clientExtensionResults ?? {}) as AuthenticationResponseJSON['clientExtensionResults'],
    ...(r.authenticatorAttachment === 'platform' || r.authenticatorAttachment === 'cross-platform' ? { authenticatorAttachment: r.authenticatorAttachment } : {}),
  };
}

export async function nativePasskeyAvailable(): Promise<{ available: boolean; prf: boolean }> {
  try { return await (await nativePlugin('KithwallPasskey')).isAvailable(); } catch { return { available: false, prf: false }; }
}

export async function nativeCreate(options: PublicKeyCredentialCreationOptionsJSON, prfSalt: Uint8Array): Promise<{ response: RegistrationResponseJSON; prf: Uint8Array | null; enabled: boolean }> {
  const request = {
    ...options,
    authenticatorSelection: { ...(options.authenticatorSelection ?? {}), residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { ...(options.extensions ?? {}), ...prfExtension(prfSalt) },
  };
  let out: Json;
  try {
    const r = await (await nativePlugin('KithwallPasskey')).create({ requestJson: JSON.stringify(request) });
    out = JSON.parse(r.responseJson) as Json;
  } catch (e) { throw mapError(e); }
  const { output, enabled } = extractPrf(out);
  return { response: toRegistrationJSON(out), prf: output, enabled };
}

export async function nativeGet(options: PublicKeyCredentialRequestOptionsJSON, prfSalt: Uint8Array): Promise<{ response: AuthenticationResponseJSON; prf: Uint8Array | null }> {
  const request = { ...options, userVerification: 'required', extensions: { ...(options.extensions ?? {}), ...prfExtension(prfSalt) } };
  let out: Json;
  try {
    const r = await (await nativePlugin('KithwallPasskey')).get({ requestJson: JSON.stringify(request) });
    out = JSON.parse(r.responseJson) as Json;
  } catch (e) { throw mapError(e); }
  const { output } = extractPrf(out);
  return { response: toAuthenticationJSON(out), prf: output };
}
