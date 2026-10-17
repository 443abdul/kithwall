/**
 * Error type for every failure raised by @kithwall/crypto.
 *
 * Messages never contain key material or plaintext; callers should branch on
 * `code`, not on `message`.
 */
export type KithwallCryptoErrorCode =
  | 'bad_password'
  | 'bad_phrase'
  | 'bad_signature'
  | 'decrypt_failed'
  | 'bad_share'
  | 'invalid_input';

export class KithwallCryptoError extends Error {
  readonly code: KithwallCryptoErrorCode;

  constructor(code: KithwallCryptoErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'KithwallCryptoError';
    this.code = code;
  }
}

/** Throws an `invalid_input` error. */
export function invalid(message: string): never {
  throw new KithwallCryptoError('invalid_input', message);
}

/** Throws a KithwallCryptoError with the given code. */
export function fail(code: KithwallCryptoErrorCode, message?: string): never {
  throw new KithwallCryptoError(code, message);
}
