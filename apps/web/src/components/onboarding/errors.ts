'use client';
import { AccountError, type AccountErrorCode } from '@/lib/auth/account';
import type { MessageKey, TFunction } from '@/i18n';

/** Friendly, translated copy for every AccountError code (lib/auth/account.ts). */
export const ACCOUNT_ERROR_KEYS: Record<AccountErrorCode, MessageKey> = {
  handle_taken: 'errors.handle_taken',
  handle_invalid: 'errors.handle_invalid',
  passkey_cancelled: 'errors.passkey_cancelled',
  passkey_unsupported: 'errors.passkey_unsupported',
  passkey_not_linked: 'errors.passkey_not_linked',
  proof_failed: 'errors.proof_failed',
  signup_expired: 'errors.signup_expired',
  prf_unsupported: 'errors.prf_unsupported',
  no_account_for_passkey: 'errors.no_account_for_passkey',
  rate_limited: 'errors.rate_limited',
  network: 'errors.network',
  weak_passphrase: 'errors.weak_passphrase',
  wrong_passphrase: 'errors.wrong_passphrase',
  unknown: 'errors.unknown',
  mfa_required: 'errors.mfa_required',
  last_unlock_method: 'errors.last_unlock_method',
  signups_closed: 'errors.signups_closed',
  no_account: 'errors.no_account',
  no_trustees: 'errors.no_trustees',
  bad_recovery_key: 'errors.bad_recovery_key',
};

export function errorCode(e: unknown): AccountErrorCode {
  if (e instanceof AccountError) return e.code;
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    && (e as { code: string }).code in ACCOUNT_ERROR_KEYS) return (e as { code: AccountErrorCode }).code;
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'network';
  return 'unknown';
}

export function accountErrorMessage(t: TFunction, e: unknown): string {
  return t(ACCOUNT_ERROR_KEYS[errorCode(e)]);
}
