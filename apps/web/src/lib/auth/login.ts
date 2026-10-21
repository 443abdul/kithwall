'use client';
// Login with optional MFA (spec §3.3, §7). The database requires an aal2 session once a user has a
// verified TOTP factor (migration 20261018000100), so for those users the key bundle is invisible
// until the code is entered: we sign in, ask for the code, then load and unlock the keys.
import { getSession, initSession, signIn, unlock, type SessionStatus } from '../keys/session';
import { sb } from '../supabase';
import { markRecoveryNudge } from '../../components/onboarding/nudges';
import { AccountError } from './account';
import { isUnconfirmedEmailError } from './login-errors';

/** Same key as components/onboarding/nudges.ts ('show' | 'dismissed'; absent = never offered on this device). */
const RECOVERY_NUDGE_KEY = 'kw.nudge.recovery';

let pending: { password: string; remember: boolean } | null = null;

export type LoginOutcome = SessionStatus | 'mfa';

/** True when this session has a verified factor but hasn't passed the TOTP step yet. */
export async function mfaRequired(): Promise<boolean> {
  const { data, error } = await sb().auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

export async function logIn(email: string, password: string, remember: boolean): Promise<LoginOutcome> {
  pending = null;
  let st: SessionStatus;
  try {
    st = await signIn(email.trim(), password, remember);
  } catch (e) {
    // A v1 sign-up whose email was never confirmed: say so instead of a generic failure.
    if (isUnconfirmedEmailError(e)) throw new AccountError('email_unconfirmed', (e as Error).message);
    throw e;
  }
  if (st === 'setup' && await mfaRequired()) {
    pending = { password, remember };
    return 'mfa';
  }
  await afterLogin();
  return getSession().status;
}

/** Verify a 6-digit TOTP code for this session (upgrades it to aal2). */
export async function verifyTotp(code: string): Promise<void> {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) throw new Error('Enter the 6-digit code from your authenticator app.');
  const { data, error } = await sb().auth.mfa.listFactors();
  if (error) throw new Error(error.message);
  const factor = data.totp.find((f) => f.status === 'verified');
  if (!factor) throw new Error('No authenticator app is set up for this account.');
  const v = await sb().auth.mfa.challengeAndVerify({ factorId: factor.id, code: clean });
  if (v.error) throw new Error(v.error.message.includes('Invalid') ? 'That code didn\'t work. Check the time on your phone and try again.' : v.error.message);
}

/** After the TOTP step: reload the session (keys are now readable) and unlock with the password we kept. */
export async function finishMfaLogin(code: string): Promise<SessionStatus> {
  await verifyTotp(code);
  await initSession();
  const p = pending;
  pending = null;
  if (p && getSession().status === 'locked') await unlock(p.password, p.remember);
  if (getSession().status === 'ready') await afterLogin();
  return getSession().status;
}

export function hasPendingPassword() { return pending !== null; }
export function clearPending() { pending = null; }

/**
 * A normal login proves the password, so it cancels any "I've lost everything" deletion that is
 * waiting to happen (and leaves a note for the in-app notice).
 */
export async function afterLogin(): Promise<void> {
  if (getSession().status !== 'ready') return;
  try {
    const { data } = await sb().rpc('cancel_account_deletion');
    if (data === true) { sessionStorage.setItem('kw.deletionCancelled', '1'); window.dispatchEvent(new Event('kw:deletion-cancelled')); }
  } catch { /* non-fatal */ }
  await offerRecoveryNudgeToV1().catch(() => undefined);
}

/**
 * Kithwall 2 turns the "save your recovery key" nudge on at sign-up; accounts from Kithwall Classic never pass
 * through that, and the server has no record that they kept the phrase v1 showed them (account_security is new).
 * So on their first password sign-in on a device, show the nudge unless it was dismissed or answered before
 * (docs/v2/07-launch.md §3). Passphrase accounts (synthetic @id.kithwall.invalid address) got it at sign-up.
 */
async function offerRecoveryNudgeToV1(): Promise<void> {
  const email = getSession().email ?? '';
  if (!email || /@id\.kithwall\.invalid$/i.test(email)) return;
  if (localStorage.getItem(RECOVERY_NUDGE_KEY) !== null) return;
  const { data } = await sb().from('account_security').select('recovery_saved_at').maybeSingle();
  if (!data?.recovery_saved_at) markRecoveryNudge();
}
