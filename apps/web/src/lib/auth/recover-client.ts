'use client';
// Browser side of account recovery from a @handle (docs/v2/01-accounts.md §3 "Recovering an account").
//
//   recovery key   handle → /api/recovery/account (nonce + recovery parts of the key bundle)
//                  → unlock the identity key with the 24 words on this device → sign the nonce
//                  → /api/recovery/finish → one-time session token → keys ready in memory
//   trusted friends handle + a fresh ephemeral key → /api/recovery/friends/start → wait (24 h) while
//                  friends approve after hearing the six words → /friends/status returns their shares,
//                  sealed to the ephemeral key → rebuild the recovery key → same finish as above →
//                  fresh recovery key, re-split to the same friends.
// Afterwards the person sets a new way in: a passkey (accountApi.addPasskey) or a passphrase.
// Works for passkey, passphrase and v1 email accounts alike; no email is needed.
import {
  KithwallCryptoError, b64u, combineRecoveryShares, generateEphemeral, openSealed, signChallenge, unlockWithRecoveryKey,
  unlockWithRecoveryPhrase, verificationPhrase, type KeyBundle, type Unlocked,
} from '@kithwall/crypto';
import { sb } from '../supabase';
import {
  adoptUnlocked, amk, fetchBundle, getSession, holdPendingAmk, identity, me, newRecoveryPhrase, noteSignedIn, setNewPassword,
} from '../keys/session';
import { dropEph, loadEph, releaseContext, resplitToSameTrustees, storeEph, subsets } from '../recovery';
import { AccountError } from './account';
import { afterLogin, mfaRequired } from './login';
import { api } from './passkey-client';
import { proveKey } from '../keys/proof';
import { fetchChallenge, solve } from './altcha';
import { isSyntheticEmail, normalizeHandle } from './passkey-shared';
import {
  cleanPhrase, type FriendsStartRes, type FriendsStatusRes, type RecoverAccountRes, type RecoverFinishRes,
} from './recovery-shared';

export interface RecoveryTarget extends RecoverAccountRes { handle: string }
export type RecoverOutcome = 'ready' | 'mfa';

/** A fresh proof-of-work: the unauthenticated recovery routes require one (security review W4). */
async function proofOfWork(): Promise<string> {
  const { challenge } = await fetchChallenge();
  return solve(challenge);
}

/** Look the account up and get a fresh, single-use nonce (5 minutes) for it. */
export async function findAccount(rawHandle: string): Promise<RecoveryTarget> {
  const handle = normalizeHandle(rawHandle);
  const res = await api<RecoverAccountRes>('/api/recovery/account', { handle, altcha: await proofOfWork() });
  return { ...res, handle };
}

/** Open the account's keys with a typed 24-word recovery key (all on this device). */
export function openWithPhrase(t: RecoveryTarget, raw: string): Unlocked {
  const { phrase } = cleanPhrase(raw);
  try {
    return unlockWithRecoveryPhrase(t.userId, t.bundle as KeyBundle, phrase);
  } catch (e) {
    if (e instanceof KithwallCryptoError) throw new AccountError('bad_recovery_key');
    throw e;
  }
}

/**
 * Prove the keys are open (sign the nonce with the identity key) and start a session. Accounts with an
 * authenticator app come back 'mfa': the keys wait in memory until finishMfaLogin(code).
 */
export async function finishRecovery(t: RecoveryTarget, u: Unlocked, requestId?: string): Promise<RecoverOutcome> {
  const signature = signChallenge(u.identity.signPriv, t.nonce);
  const { tokenHash } = await api<RecoverFinishRes>('/api/recovery/finish', {
    userId: t.userId, challengeId: t.challengeId, signature, ...(requestId ? { requestId } : {}),
  });
  const { data, error } = await sb().auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (error || !data.user) throw new AccountError('network', error?.message ?? 'Could not start the session.');
  const email = data.user.email ?? null;
  if (await mfaRequired()) {
    holdPendingAmk(t.userId, u.amk);
    noteSignedIn(t.userId, email, 'setup');
    return 'mfa';
  }
  await adoptUnlocked(t.userId, email, u, true);
  await afterLogin();
  return 'ready';
}

// ---------------------------------------------------------------------------------------------
// Trusted friends

const PENDING = 'kw.recovery.pending';
export interface PendingRecovery { handle: string; userId: string; requestId: string }

export function pendingRecovery(): PendingRecovery | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING) ?? 'null') as PendingRecovery | null;
    return v && typeof v.requestId === 'string' && typeof v.handle === 'string' ? v : null;
  } catch { return null; }
}
function setPending(v: PendingRecovery | null) {
  try { if (v) localStorage.setItem(PENDING, JSON.stringify(v)); else localStorage.removeItem(PENDING); } catch { /* ignore */ }
}

/** Start a request; this device keeps the ephemeral private key (wrapped, in IndexedDB). */
export async function startFriends(t: RecoveryTarget): Promise<FriendsStartRes> {
  const e = generateEphemeral();
  try {
    const res = await api<FriendsStartRes>('/api/recovery/friends/start', { handle: t.handle, ephPub: b64u.encode(e.pub), altcha: await proofOfWork() });
    await storeEph(t.userId, res.requestId, e.priv);
    setPending({ handle: t.handle, userId: t.userId, requestId: res.requestId });
    return res;
  } finally {
    e.priv.fill(0);
  }
}

export function friendsStatus(requestId: string): Promise<FriendsStatusRes> {
  return api<FriendsStatusRes>('/api/recovery/friends/status', { requestId });
}

/** The six words both sides see: the owner reads them out, each friend checks them before approving. */
export function sixWords(requestId: string, ephPub: string): string[] {
  return verificationPhrase(requestId, b64u.decode(ephPub));
}

export async function hasEphHere(userId: string, requestId: string): Promise<boolean> {
  const p = await loadEph(userId, requestId).catch(() => null);
  if (!p) return false;
  p.fill(0);
  return true;
}

export async function cancelFriends(requestId: string): Promise<void> {
  await api('/api/recovery/friends/cancel', { requestId });
  await dropEph(requestId);
  setPending(null);
}

export function forgetPending() { setPending(null); }

/** Rebuild the recovery key from the friends' released shares and open the account's keys. */
export async function rebuildFromFriends(t: RecoveryTarget, requestId: string, st: FriendsStatusRes): Promise<Unlocked> {
  const priv = await loadEph(t.userId, requestId);
  if (!priv) throw new AccountError('unknown', 'This recovery was started on another device or browser.');
  const ephPub = b64u.decode(st.ephPub);
  const shares: Uint8Array[] = [];
  try {
    for (const r of st.responses) {
      try {
        shares.push(openSealed({
          sealed: r.sealed, recipientKxPriv: priv, recipientKxPub: ephPub, senderSignPub: b64u.decode(r.signPub),
          context: releaseContext(requestId, r.trusteeId),
        }));
      } catch (e) { console.warn('ignored a recovery share that failed verification', r.trusteeId, e); }
    }
    if (shares.length < 2) throw new AccountError('bad_recovery_key');
    // Largest set first; a bad share makes the commitment check fail, so fall back to subsets.
    const sets = subsets(shares).filter((s) => s.length >= 2).sort((a, b) => b.length - a.length);
    for (const s of sets) {
      let rk: Uint8Array | null = null;
      try { rk = await combineRecoveryShares(s.slice(0, 5), t.bundle.rkCommitment); } catch { continue; }
      try { return unlockWithRecoveryKey(t.userId, t.bundle as KeyBundle, rk); } finally { rk.fill(0); }
    }
    throw new AccountError('bad_recovery_key');
  } finally {
    priv.fill(0);
    shares.forEach((s) => s.fill(0));
  }
}

/** After a trusted-friend recovery (session ready): a fresh recovery key, re-split to the same friends. */
export async function afterFriendsRecovery(requestId: string): Promise<{ phrase: string; resplit: boolean }> {
  await dropEph(requestId);
  setPending(null);
  const fresh = await newRecoveryPhrase();
  const resplit = await resplitToSameTrustees(fresh.rk);
  return { phrase: fresh.phrase, resplit };
}

// ---------------------------------------------------------------------------------------------
// A new way in

/**
 * Set a new passphrase (email-less accounts) or password (v1 accounts) for the signed-in, unlocked
 * account. Email-less accounts are then marked so that @handle + passphrase sign-in finds them.
 */
export async function setNewPassphrase(passphrase: string): Promise<void> {
  const userId = me();
  const email = getSession().email;
  if (!email) throw new AccountError('unknown', 'Please sign in again.');
  const bundle = await fetchBundle(userId);
  if (!bundle) throw new AccountError('unknown', 'No keys found for this account.');
  await setNewPassword(userId, email, bundle, { amk: amk(), identity: identity() }, passphrase);
  if (isSyntheticEmail(email)) {
    const { data } = await sb().auth.getSession();
    // Proof that this device holds the unlocked identity key, not just a token (security review W2).
    await api('/api/auth/passkey/passphrase/enable', await proveKey('add_credential'), data.session?.access_token);
  }
}
