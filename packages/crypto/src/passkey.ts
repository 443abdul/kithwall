/**
 * Passkey (WebAuthn PRF) key wrapping — Kithwall 2 (docs/v2/01-accounts.md).
 *
 * Every sign-in asks the authenticator for PRF(credential secret, PRF_APP_SALT). The input is one
 * fixed per-app constant so that a *discoverable* sign-in (no username, no allow-list, so no
 * per-credential `evalByCredential`) still gets a usable output. The per-credential separation
 * comes from a random 32-byte `credSalt` stored next to the wrap and used as the HKDF salt:
 *
 *   prfOutput   = WebAuthn PRF(credential, PRF_APP_SALT)                         (32 B, never leaves device)
 *   wrapKey     = HKDF-SHA-256(prfOutput, salt = credSalt, "kithwall/v1/prf-wrap")
 *   amkByPasskey= b64u(0x01 ‖ nonce ‖ XChaCha20-Poly1305(wrapKey, AMK,
 *                    aad "kithwall/v1/wrap/amk-passkey/<userId>/<credentialId>"))
 *
 * The server stores (credentialId, credSalt, amkByPasskey). It never sees prfOutput or AMK.
 */
import { KithwallCryptoError, fail } from './errors';
import { assertBytes, assertString, b64u, decodeFixed, randomBytes, utf8, wipe } from './encoding';
import { type KeyBundle, type Unlocked, unlockWithAmk } from './keys';
import { KEY_LEN, hkdfSha256, packDecrypt, packEncrypt, sha256 } from './primitives';

/** PRF `eval.first` input for every Kithwall passkey: SHA-256("kithwall/v1/prf-app-salt"). */
export const PRF_APP_SALT: Uint8Array = sha256(utf8('kithwall/v1/prf-app-salt'));

/** Fresh credential-specific salt (base64url, 32 bytes). */
export function newPrfSalt(): string {
  return b64u.encode(randomBytes(KEY_LEN));
}

function checkCredentialId(credentialId: string): void {
  assertString(credentialId, 'credentialId', 1400);
  // WebAuthn credential ids are at most 1023 bytes; ours are base64url strings.
  if (credentialId.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(credentialId)) fail('invalid_input', 'bad credentialId');
}

/** AAD binding a passkey wrap to the account and the credential. */
export function passkeyWrapAad(userId: string, credentialId: string): Uint8Array {
  assertString(userId, 'userId');
  checkCredentialId(credentialId);
  return utf8(`kithwall/v1/wrap/amk-passkey/${userId}/${credentialId}`);
}

/** HKDF(prfOutput, salt = credSalt, "kithwall/v1/prf-wrap"). PRF outputs shorter than 32 bytes are refused. */
export function prfWrapKey(prfOutput: Uint8Array, credSalt: string): Uint8Array {
  assertBytes(prfOutput, 'prfOutput');
  if (prfOutput.length < KEY_LEN) fail('invalid_input', 'PRF output must be at least 32 bytes');
  const salt = decodeFixed(credSalt, 'credSalt', KEY_LEN);
  return hkdfSha256(prfOutput, 'kithwall/v1/prf-wrap', KEY_LEN, salt);
}

/** Wraps the AMK for one passkey. */
export function wrapAmkWithPrf(userId: string, credentialId: string, amk: Uint8Array, prfOutput: Uint8Array, credSalt: string): string {
  assertBytes(amk, 'amk', KEY_LEN);
  const aad = passkeyWrapAad(userId, credentialId);
  const key = prfWrapKey(prfOutput, credSalt);
  try {
    return packEncrypt(key, amk, aad);
  } finally {
    wipe(key);
  }
}

/** Unwraps the AMK; a wrong passkey/salt/user/credential or tampering is `decrypt_failed`. */
export function unwrapAmkWithPrf(userId: string, credentialId: string, wrapped: string, prfOutput: Uint8Array, credSalt: string): Uint8Array {
  assertString(wrapped, 'wrapped');
  const aad = passkeyWrapAad(userId, credentialId);
  const key = prfWrapKey(prfOutput, credSalt);
  let amk: Uint8Array;
  try {
    amk = packDecrypt(key, wrapped, aad);
  } finally {
    wipe(key);
  }
  if (amk.length !== KEY_LEN) fail('decrypt_failed', 'malformed AMK');
  return amk;
}

/** Unwraps the AMK with the passkey and opens the identity keys (checked against the bundle). */
export function unlockWithPrf(
  userId: string, bundle: KeyBundle, credentialId: string, wrapped: string, prfOutput: Uint8Array, credSalt: string,
): Unlocked {
  const amk = unwrapAmkWithPrf(userId, credentialId, wrapped, prfOutput, credSalt);
  try {
    return unlockWithAmk(userId, bundle, amk);
  } catch (e) {
    if (e instanceof KithwallCryptoError) throw e;
    return fail('decrypt_failed', 'could not open identity');
  } finally {
    wipe(amk);
  }
}
