'use client';
// Kithwall 2 account API: passkey-first sign-up and sign-in, passphrase fallback, v1 migration.
// This file is the contract between the onboarding UI (components/onboarding, app/(auth)) and the
// key/auth implementation (lib/auth/passkey*, app/api/auth/passkey/*). The UI only imports from here.
// See docs/v2/00-brief.md §5 and docs/v2/01-accounts.md.

export type StylePref = 'warm' | 'minimal' | 'bold';
export type ModePref = 'system' | 'light' | 'dark';

export interface Capabilities {
  /** WebAuthn available on this device. */
  passkey: boolean;
  /** Platform authenticator likely supports the PRF extension (needed to wrap keys with the passkey). */
  prf: boolean | 'unknown';
}

export interface CreateAccountInput {
  displayName: string;
  handle: string;              // without '@'; validated with handleProblem()
  /** Proof-of-work solution (ALTCHA payload), solved invisibly by the UI before submit. */
  altcha: string;
  inviteCode?: string;
  /** Only when the user chose the passphrase fallback (no passkey/PRF). */
  passphrase?: string;
}

export type AccountErrorCode =
  | 'handle_taken' | 'handle_invalid' | 'passkey_cancelled' | 'passkey_unsupported' | 'prf_unsupported'
  | 'no_account_for_passkey' | 'rate_limited' | 'network' | 'weak_passphrase' | 'wrong_passphrase' | 'unknown';

export class AccountError extends Error {
  constructor(public code: AccountErrorCode, message?: string) { super(message ?? code); }
}

export interface AccountApi {
  capabilities(): Promise<Capabilities>;
  /** null when fine, otherwise a reason code. Cheap: format check + debounced availability lookup. */
  handleProblem(handle: string): Promise<null | 'invalid' | 'taken' | 'reserved'>;
  /** Creates the auth user, keys (wrapped by the passkey PRF or the passphrase) and profile; leaves the session 'ready'. */
  createAccount(input: CreateAccountInput): Promise<{ recoveryNudge: true }>;
  /** Discoverable-credential sign-in ("Sign in with passkey"); unlocks keys; session becomes 'ready'. */
  signInWithPasskey(): Promise<void>;
  /** Fallback sign-in for passphrase accounts: handle + passphrase. */
  signInWithPassphrase(handle: string, passphrase: string): Promise<void>;
  /** v1 accounts: email + password, then the UI offers addPasskey(). */
  signInLegacy(email: string, password: string): Promise<'ready' | 'mfa'>;
  /** Adds a passkey to the signed-in, unlocked account (also wraps the keys for it). */
  addPasskey(label?: string): Promise<void>;
  listPasskeys(): Promise<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }[]>;
  removePasskey(id: string): Promise<void>;
  /** Optional email for account notices (verified by link). */
  setNoticeEmail(email: string | null): Promise<void>;
}

// Implementation is provided by ./account-impl (kept separate so the UI can be built against a mock).
export { accountApi } from './account-impl';
