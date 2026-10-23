'use client';
// Kithwall 2 AccountApi (contract: ./account.ts; design: docs/v2/01-accounts.md).
//
//  sign-up   handle + ALTCHA → /register/options (user id allocated) → passkey with PRF created on
//            device → keys generated on device, AMK wrapped with HKDF(PRF) → /register/verify creates
//            the email-less auth user, key bundle, profile and passkey in one go → one-time token →
//            verifyOtp → 'ready'. Passphrase fallback: same, AMK wrapped by Argon2id(passphrase).
//  sign-in   discoverable passkey → /login/verify → token + this passkey's AMK wrap → unwrap locally.
//            Passphrase accounts: @handle → synthetic address → Argon2id on device → /passphrase/signin.
import {
  KithwallCryptoError, createKeyBundle, deriveFromPassword, newPrfSalt, unlockWithPrf, unwrapAmkWithPrf, wrapAmkWithPrf,
  type KeyBundle,
} from '@kithwall/crypto';
import { sb } from '../supabase';
import {
  adoptUnlocked, amk as currentAmk, confirmRecoverySaved, fetchBundle, getSession, holdPendingAmk, initSession,
  newRecoveryPhrase, noteSignedIn, unlockOptions, unlockWithPasskey, type PasswordGrant,
} from '../keys/session';
import { AccountError, type AccountApi, type Capabilities } from './account';
import { logIn, mfaRequired } from './login';
import { addPasskeyProof } from '../keys/proof';
import { passwordStrength } from './password';
import { api, createPasskey, getPasskey, prfSupport, webauthnAvailable } from './passkey-client';
import {
  deviceLabel, handleShapeProblem, normalizeHandle,
  type AddOptionsRes, type AddVerifyRes, type HandleProblem, type LoginOptionsRes, type LoginVerifyReq, type LoginVerifyRes,
  type LookupRes, type NoticeEmailRes, type PassphraseSignInReq, type PassphraseSignInRes, type RegisterOptionsRes, type RegisterVerifyReq, type RegisterVerifyRes,
} from './passkey-shared';

const BASE = '/api/auth/passkey';

async function accessToken(): Promise<string> {
  const { data } = await sb().auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new AccountError('unknown', 'Please sign in again.');
  return t;
}

/** Redeem a one-time token from /register/verify or /login/verify into a Supabase session. */
async function redeem(tokenHash: string): Promise<{ userId: string; email: string | null }> {
  const { data, error } = await sb().auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (error || !data.session || !data.user) throw new AccountError('network', error?.message ?? 'Could not start the session.');
  return { userId: data.user.id, email: data.user.email ?? null };
}

/**
 * Passphrase sign-in goes through the server (security re-review R-W3): it checks authKey with a constant-cost
 * hash, limits attempts per handle and mints the session, so sign-in timing can't reveal passphrase accounts.
 * The browser never calls GoTrue's password grant for synthetic (handle) accounts.
 */
const passphraseGrant: PasswordGrant = async (email, authKey) => {
  const body: PassphraseSignInReq = { email, authKey };
  const { tokenHash } = await api<PassphraseSignInRes>(`${BASE}/passphrase/signin`, body);
  return (await redeem(tokenHash)).userId;
};

function cryptoToAccount(e: unknown, fallback: AccountError): never {
  if (e instanceof AccountError) throw e;
  if (e instanceof KithwallCryptoError) throw fallback;
  throw new AccountError('unknown', (e as Error)?.message);
}

// After sign-up: the encrypted display name (profile_info, friends audience) and invite redemption.
// Lazy imports keep the v1 social modules out of the sign-in bundle path until needed.
async function finishProfile(displayName: string, inviteCode?: string) {
  const friends = await import('../friends');
  await friends.saveProfileInfo({ name: displayName.trim().slice(0, 80) });
  if (inviteCode) {
    try {
      const { data: inviter } = await sb().rpc('redeem_invite', { invite_code: inviteCode });
      if (typeof inviter === 'string') await friends.notify(inviter, 'friend_request', 'profile', getSession().userId!).catch(() => undefined);
    } catch { /* expired or used-up invite: not fatal */ }
  }
}

// Debounced, cached availability lookups for handleProblem().
const handleCache = new Map<string, Exclude<HandleProblem, 'invalid'>>();
let handleTimer: ReturnType<typeof setTimeout> | null = null;
let handleWaiters: ((v: HandleProblem) => void)[] = [];

async function lookupHandle(h: string): Promise<HandleProblem> {
  if (handleCache.has(h)) return handleCache.get(h)!;
  const r = await api<{ problem: HandleProblem }>(`${BASE}/handle?h=${encodeURIComponent(h)}`, null, undefined, 'GET');
  if (r.problem !== 'invalid') handleCache.set(h, r.problem);
  if (handleCache.size > 500) handleCache.clear();
  return r.problem;
}

export const accountApi: AccountApi = {
  async capabilities(): Promise<Capabilities> {
    const passkey = webauthnAvailable();
    return { passkey, prf: passkey ? await prfSupport() : false };
  },

  handleProblem(raw) {
    const h = normalizeHandle(raw);
    const shape = handleShapeProblem(h);
    if (shape) return Promise.resolve(shape);
    if (handleCache.has(h)) return Promise.resolve(handleCache.get(h)!);
    // Debounce: only the latest call within 300 ms hits the network; earlier callers get its answer.
    return new Promise<HandleProblem>((resolve) => {
      handleWaiters.push(resolve);
      if (handleTimer) clearTimeout(handleTimer);
      handleTimer = setTimeout(() => {
        const waiters = handleWaiters; handleWaiters = []; handleTimer = null;
        lookupHandle(h).then((v) => waiters.forEach((w) => w(v)), () => waiters.forEach((w) => w(null)));
      }, 300);
    });
  },

  async createAccount(input) {
    const handle = normalizeHandle(input.handle);
    const shape = handleShapeProblem(handle);
    if (shape) throw new AccountError(shape === 'reserved' ? 'handle_taken' : 'handle_invalid');
    const displayName = input.displayName.trim();
    if (!displayName) throw new AccountError('unknown', 'Please enter your name.');
    const mode = input.passphrase ? 'passphrase' : 'passkey';
    if (input.passphrase !== undefined) {
      const s = passwordStrength(input.passphrase, [handle, displayName]);
      if (!s.ok) throw new AccountError('weak_passphrase', s.hint ?? 'Please choose a stronger passphrase.');
    } else if (!webauthnAvailable()) {
      throw new AccountError('passkey_unsupported');
    }

    const start = await api<RegisterOptionsRes>(`${BASE}/register/options`, { handle, altcha: input.altcha, mode });
    const { userId } = start;

    if (mode === 'passkey') {
      const made = await createPasskey(start.options!, displayName);   // PRF output stays here
      const { bundle, unlocked } = createKeyBundle(userId, null);
      const prfSalt = newPrfSalt();
      const amkWrap = wrapAmkWithPrf(userId, made.credentialId, unlocked.amk, made.prf, prfSalt);
      made.prf.fill(0);
      const body: RegisterVerifyReq = {
        challengeId: start.challengeId, bundle,
        passkey: { response: made.response, label: deviceLabel(navigator.userAgent), prfSalt, amkWrap },
      };
      const done = await api<RegisterVerifyRes>(`${BASE}/register/verify`, body);
      const s = await redeem(done.tokenHash!);
      if (s.userId !== userId) throw new AccountError('unknown', 'Session mismatch.');
      await adoptUnlocked(userId, s.email, unlocked);
    } else {
      const email = start.email!;
      const { authKey, passwordKEK } = await deriveFromPassword(email, input.passphrase!);
      const { bundle, unlocked } = createKeyBundle(userId, passwordKEK);
      passwordKEK.fill(0);
      const body: RegisterVerifyReq = { challengeId: start.challengeId, bundle, authKey };
      await api<RegisterVerifyRes>(`${BASE}/register/verify`, body);
      const signedIn = await passphraseGrant(email, authKey);
      if (signedIn !== userId) throw new AccountError('unknown', 'Session mismatch.');
      await adoptUnlocked(userId, email, unlocked);
    }
    if (getSession().status !== 'ready') throw new AccountError('unknown', 'Your account was created but could not be opened. Please sign in.');
    await finishProfile(displayName, input.inviteCode).catch((e) => console.warn('profile info', e));
    // The recovery phrase made with the keys is not shown now (brief §5: a nudge, not a blocker);
    // the UI later calls newRecoveryPhrase() + confirmRecoverySaved().
    return { recoveryNudge: true };
  },

  async signInWithPasskey() {
    const start = await api<LoginOptionsRes>(`${BASE}/login/options`, {});
    const a = await getPasskey(start.options);
    const body: LoginVerifyReq = { challengeId: start.challengeId, response: a.response };
    let done: LoginVerifyRes;
    try {
      done = await api<LoginVerifyRes>(`${BASE}/login/verify`, body);
    } catch (e) { a.prf?.fill(0); throw e; }
    const s = await redeem(done.tokenHash);
    try {
      if (!a.prf || !done.wrap) {
        // Signed in, but this passkey can't open the keys here: leave the session locked.
        await initSession();
        throw new AccountError('prf_unsupported', 'Signed in, but this passkey can\'t unlock your keys on this device.');
      }
      const bundle = await fetchBundle(s.userId);
      if (!bundle) {
        if (await mfaRequired()) {
          // TOTP-enrolled account on an aal1 session: keep the AMK until finishMfaLogin(code).
          holdPendingAmk(s.userId, unwrapAmkWithPrf(s.userId, done.credentialId, done.wrap.amkWrap, a.prf, done.wrap.prfSalt));
          noteSignedIn(s.userId, s.email, 'setup');
          throw new AccountError('mfa_required');
        }
        throw new AccountError('unknown', 'No keys found for this account.');
      }
      const u = unlockWithPrf(s.userId, bundle as KeyBundle, done.credentialId, done.wrap.amkWrap, a.prf, done.wrap.prfSalt);
      await adoptUnlocked(s.userId, s.email, u);
    } catch (e) {
      cryptoToAccount(e, new AccountError('prf_unsupported', 'This passkey could not unlock your keys.'));
    } finally {
      a.prf?.fill(0);
    }
  },

  async signInWithPassphrase(rawHandle, passphrase) {
    const handle = normalizeHandle(rawHandle);
    if (handleShapeProblem(handle) === 'invalid') throw new AccountError('wrong_passphrase');
    const { email } = await api<LookupRes>(`${BASE}/passphrase/lookup`, { handle });
    let outcome;
    try {
      outcome = await logIn(email, passphrase, true, passphraseGrant);
    } catch (e) {
      if (e instanceof AccountError && (e.code === 'wrong_passphrase' || e.code === 'rate_limited')) throw new AccountError(e.code);
      if (e instanceof KithwallCryptoError || /incorrect|invalid/i.test((e as Error).message)) throw new AccountError('wrong_passphrase');
      if (/rate|too many/i.test((e as Error).message)) throw new AccountError('rate_limited');
      throw new AccountError('network', (e as Error).message);
    }
    if (outcome === 'mfa') throw new AccountError('mfa_required');
    if (outcome !== 'ready') throw new AccountError('unknown', 'This account is not set up yet.');
  },

  async addPasskey(label) {
    const st = getSession();
    if (st.status !== 'ready' || !st.userId) throw new AccountError('unknown', 'Unlock Kithwall first.');
    const userId = st.userId;
    const token = await accessToken();
    const start = await api<AddOptionsRes>(`${BASE}/add/options`, {}, token);
    const made = await createPasskey(start.options);
    const prfSalt = newPrfSalt();
    const amkWrap = wrapAmkWithPrf(userId, made.credentialId, currentAmk(), made.prf, prfSalt);
    made.prf.fill(0);
    await api<AddVerifyRes>(`${BASE}/add/verify`, {
      challengeId: start.challengeId, response: made.response, label: label?.trim() || deviceLabel(navigator.userAgent),
      prfSalt, amkWrap,
      // Proof that this unlocked device holds the identity key, not just an access token (security review W2).
      keyProof: addPasskeyProof(start.options.challenge),
    }, await accessToken());
  },

  async listPasskeys() {
    const { data, error } = await sb().from('passkeys').select('id, label, created_at, last_used_at').order('created_at');
    if (error) throw new AccountError('network', error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string, label: r.label as string, createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null,
    }));
  },

  async removePasskey(id) {
    const { error } = await sb().rpc('remove_passkey', { p_id: id });
    if (!error) return;
    if (error.code === 'P0001' || /last unlock method/i.test(error.message)) throw new AccountError('last_unlock_method');
    if (error.code === 'P0429') throw new AccountError('rate_limited');
    throw new AccountError('unknown', error.message);
  },

  async setNoticeEmail(email) {
    const value = email === null ? null : email.trim();
    await api<NoticeEmailRes>(`${BASE}/notice-email`, { email: value || null }, await accessToken());
  },

  unlockWithPasskey: async () => {
    try {
      await unlockWithPasskey();
    } catch (e) {
      cryptoToAccount(e, new AccountError('prf_unsupported', 'This passkey could not unlock your keys.'));
    }
  },

  unlockOptions: () => unlockOptions(),

  async newRecoveryPhrase() {
    return (await newRecoveryPhrase()).phrase;
  },

  confirmRecoverySaved: () => confirmRecoverySaved(),

  async accountStatus() {
    const userId = getSession().userId;
    if (!userId) throw new AccountError('unknown', 'Not signed in');
    const [sec, pk, bundle] = await Promise.all([
      sb().from('account_security').select('recovery_saved_at, notice_email, notice_email_verified_at').maybeSingle(),
      sb().from('passkeys').select('id', { count: 'exact', head: true }),
      fetchBundle(userId),
    ]);
    return {
      recoverySaved: !!sec.data?.recovery_saved_at,
      noticeEmail: sec.data?.notice_email_verified_at ? (sec.data.notice_email as string) : null,
      passkeys: pk.count ?? 0,
      hasPassphrase: typeof bundle?.amkByPassword === 'string',
    };
  },
};
