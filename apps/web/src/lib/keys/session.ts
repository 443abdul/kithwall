'use client';
// Client session: Supabase auth + the user's unlocked keys (held in memory only).
// See docs/03-spec.md §3.1–3.4 and §3.13.
import {
  b64u, deriveFromPassword, deriveCacheKey, unlockWithPassword,
  rewrapPassword, rotateRecovery, signChallenge, unlockWithAmk, unlockWithPrf, KithwallCryptoError,
  type Identity, type KeyBundle, type Unlocked,
} from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { sb, must } from '../supabase';
import type { ProfileRow } from '../types';
import { keyring } from './keyring';
import { deviceStore } from './device';
import { clientRpId, evaluatePrf } from '../auth/passkey-client';
import { authedPost } from '../auth/api';
import { people } from '../people';
import { isOfflineError, OfflineError, setKnownOffline, storedAuthUser } from '../net/offline';
import { offlineStore, trackOfflineSnapshot } from './offline';

export type SessionStatus =
  | 'loading'     // checking for an existing session
  | 'signed_out'
  | 'locked'      // Supabase session exists but keys are not in memory (enter password to unlock)
  | 'setup'       // signed in, but the key bundle isn't readable yet (authenticator-app code still needed)
  | 'ready';

export interface SessionState {
  status: SessionStatus;
  userId: string | null;
  email: string | null;
  profile: ProfileRow | null;
  /** 'offline_unavailable': opened without a connection, and this device has nothing to open offline with. */
  error: string | null;
  /**
   * Opened without a connection (Kit Drop, docs/v2/08-censorship.md §5): unlocked from what this device
   * kept (lib/keys/offline). Posts wait in the outbox; it switches to the normal start once the server answers.
   */
  offline?: boolean;
}

let state: SessionState = { status: 'loading', userId: null, email: null, profile: null, error: null };
let unlocked: Unlocked | null = null;
// Kithwall 2: an AMK opened with a passkey while the database still hides the key bundle (the
// account has TOTP and this session is aal1). Held in memory only; initSession() uses it once the
// TOTP step (lib/auth/login.ts finishMfaLogin) makes the bundle readable.
let pendingAmk: { userId: string; amk: Uint8Array } | null = null;
// "Keep me signed in on this device" for passkey sign-ins/sign-ups (spec §3.13 device store).
let rememberDevice = true;
export function setRememberDevice(v: boolean) { rememberDevice = v; }
export function getRememberDevice() { return rememberDevice; }
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useSession(): SessionState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
    () => state,
  );
}
export const getSession = () => state;

/** The unlocked identity. Throws if keys are not loaded. */
export function identity(): Identity {
  if (!unlocked) throw new Error('Kithwall is locked');
  return unlocked.identity;
}
export function me(): string {
  if (!state.userId) throw new Error('Not signed in');
  return state.userId;
}
export function cacheKey(): Uint8Array {
  if (!unlocked) throw new Error('Kithwall is locked');
  return deriveCacheKey(unlocked.amk);
}
export function amk(): Uint8Array {
  if (!unlocked) throw new Error('Kithwall is locked');
  return unlocked.amk;
}
/** Everything unlocked (identity, AMK, earlier key-exchange keys). For lib/keys only. */
export function unlockedKeys(): Unlocked {
  if (!unlocked) throw new Error('Kithwall is locked');
  return unlocked;
}

async function loadProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await sb().from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error && isOfflineError(error)) throw new OfflineError();
  return (data as ProfileRow | null) ?? null;
}

async function becomeReady(userId: string, email: string | null, u: Unlocked, remember: boolean) {
  unlocked = u;

  if (remember) await deviceStore.save(userId, u.amk).catch(() => undefined);
  let profile: ProfileRow | null;
  try { profile = state.offline ? null : await loadProfile(userId); }
  catch (e) { if (!isOfflineError(e)) throw e; profile = null; markOffline(true); }
  if (state.offline) { await becomeReadyOffline(userId, email, u); return; }
  if (!profile) { set({ status: 'setup', userId, email, error: null }); return; }
  stopTracking();
  set({ status: 'ready', userId, email, profile, error: null, offline: false });
  await keyring.stop(); // restart cleanly (password change / recovery re-enter here while running)
  await keyring.start(userId, u);
  // What it takes to open this account again without a connection (lib/keys/offline).
  offlineStore.allowWrites(userId);
  void offlineStore.saveProfile(userId, profile);
  void fetchBundle(userId).catch(() => undefined); // keeps the current bundle
  stopTracking = trackOfflineSnapshot(userId, () => unlocked?.amk ?? null);
}

// ---------------------------------------------------------------------------------------------
// Without a connection (Kit Drop, docs/v2/08-censorship.md §5). The account is opened from what this device
// kept the last time it was online (lib/keys/offline): the key bundle (unlocked with the remembered AMK, the
// app PIN or the passphrase, exactly as online) and the snapshot of adopted keys and trusted people. Nothing
// new is trusted while offline. Once the server answers again, the normal start runs with the same keys.
let stopTracking: () => void = () => undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function markOffline(v: boolean) {
  setKnownOffline(v);
  if (state.offline !== v) set({ offline: v });
  if (v) watchConnection(); else stopWatching();
}

async function becomeReadyOffline(userId: string, email: string | null, u: Unlocked) {
  const [snap, profile] = await Promise.all([offlineStore.snapshot(userId, u.amk), offlineStore.profile(userId)]);
  if (!snap || !profile) {
    u.amk.fill(0);
    unlocked = null;
    set({ status: 'locked', userId, email, error: 'offline_unavailable', offline: true });
    return;
  }
  stopTracking();
  stopTracking = () => undefined;
  set({ status: 'ready', userId, email, profile, error: null, offline: true });
  await keyring.stop();
  await keyring.startOffline(userId, u, snap.keyring);
  people.restore(snap.people);
}

/** Open the account from this device alone. False if it has nothing to open it with. */
async function initOffline(userId: string, email: string | null): Promise<boolean> {
  const bundle = await offlineStore.bundle(userId);
  if (!bundle) return false;
  markOffline(true);
  const amkBytes = await deviceStore.load(userId).catch(() => null);
  if (amkBytes) {
    try { await becomeReady(userId, email, unlockFromAmk(userId, bundle, amkBytes), false); return true; }
    catch { /* fall through to locked: the PIN or passphrase may still open it */ }
  }
  set({ status: 'locked', userId, email, error: null, offline: true });
  return true;
}

function stopWatching() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
}
const onOnline = () => { void reconnect(); };

function watchConnection() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', onOnline);
  if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; void reconnect(); }, 30_000);
}

let reconnecting: Promise<void> | null = null;
/** Opened offline: is the server back? Then switch to the normal start (with the keys already unlocked). */
function reconnect(): Promise<void> {
  reconnecting ??= (async () => {
    if (!state.offline) return;
    const probe = await sb().from('profiles').select('id').limit(1);
    if (probe.error && isOfflineError(probe.error)) { if (state.offline && !reconnectTimer) watchConnection(); return; }
    const { data } = await sb().auth.getSession();
    const u = unlocked;
    const userId = state.userId;
    markOffline(false);
    if (u && userId && data.session?.user.id === userId) {
      try { await becomeReady(userId, state.email, u, false); return; } catch { /* the normal start below */ }
    }
    await initSession();
  })().catch(() => { if (state.offline) watchConnection(); }).finally(() => { reconnecting = null; });
  return reconnecting;
}

/** The key bundle from the server, or (no connection) the copy this device kept. */
async function bundleFor(userId: string): Promise<KeyBundle | null> {
  if (state.offline) return (await offlineStore.bundle(userId)) ?? null;
  try { return await fetchBundle(userId); }
  catch (e) {
    const kept = isOfflineError(e) ? await offlineStore.bundle(userId) : undefined;
    if (!kept) throw e;
    markOffline(true);
    return kept;
  }
}

/** Is this page the offline entry point (public/sw.js serves it when the network can't be reached)? */
const offlineFirst = () => typeof location !== 'undefined' && (location.pathname === '/offline' || navigator.onLine === false);
const authStorageKey = () => (sb().auth as unknown as { storageKey?: string }).storageKey;

/** Restore on page load. */
// Concurrent calls (e.g. React StrictMode running the effect twice) share one run, so the keyring
// is never started twice at once.
let initRun: Promise<void> | null = null;
export function initSession(): Promise<void> {
  initRun ??= doInitSession().finally(() => { initRun = null; });
  return initRun;
}

async function doInitSession(): Promise<void> {
  // The offline entry point (or a browser that knows it's offline): open from this device straight away
  // instead of first waiting for requests that can't succeed.
  if (offlineFirst()) {
    const stored = storedAuthUser(authStorageKey());
    if (stored && await initOffline(stored.id, stored.email)) return;
  }
  const { data, error } = await sb().auth.getSession();
  const s = data.session;
  if (!s) {
    // No connection and an expired access token: supabase-js couldn't refresh it, but the session is still there.
    const stored = error && isOfflineError(error) ? storedAuthUser(authStorageKey()) : null;
    if (stored && await initOffline(stored.id, stored.email)) return;
    set({ status: 'signed_out' }); return;
  }
  const userId = s.user.id;
  const email = s.user.email ?? null;
  let bundle: KeyBundle | null;
  try { bundle = await fetchBundle(userId); }
  catch (e) { if (isOfflineError(e) && await initOffline(userId, email)) return; throw e; }
  if (!bundle) { set({ status: 'setup', userId, email }); return; }
  const amkBytes = await deviceStore.load(userId).catch(() => null);
  if (amkBytes) {
    try {
      const u = unlockFromAmk(userId, bundle, amkBytes);
      await becomeReady(userId, email, u, false);
      return;
    } catch { await deviceStore.clear(); }
  }
  const p = takePendingAmk(userId);
  if (p) {
    try {
      await becomeReady(userId, email, unlockFromAmk(userId, bundle, p), rememberDevice);
      return;
    } catch { /* fall through to locked */ }
  }
  set({ status: 'locked', userId, email });
}

function takePendingAmk(userId: string): Uint8Array | null {
  const p = pendingAmk;
  pendingAmk = null;
  return p && p.userId === userId ? p.amk : null;
}

/** Kithwall 2: keep a passkey-unwrapped AMK until the MFA step makes the key bundle readable. */
export function holdPendingAmk(userId: string, amkBytes: Uint8Array) {
  pendingAmk = { userId, amk: new Uint8Array(amkBytes) };
}

/**
 * Kithwall 2: enter 'ready' with keys opened outside this module (passkey PRF sign-in / sign-up,
 * passphrase sign-up). Loads the profile and starts the keyring like a password login.
 */
export async function adoptUnlocked(userId: string, email: string | null, u: Unlocked, remember = rememberDevice): Promise<SessionStatus> {
  pendingAmk = null;
  await becomeReady(userId, email, u, remember);
  return state.status;
}

/** Kithwall 2: refresh the auth part of the state (after verifyOtp etc.) without unlocking. */
export function noteSignedIn(userId: string, email: string | null, status: SessionStatus) {
  set({ status, userId, email, error: null });
}

/** Which ways can the current (locked) account be unlocked on this device? */
export async function unlockOptions(): Promise<{ passkey: boolean; password: boolean }> {
  if (!state.userId) return { passkey: false, password: false };
  // Offline: the passphrase works with the bundle kept here; a passkey needs its wrap from the server.
  if (state.offline) return { passkey: false, password: typeof (await offlineStore.bundle(state.userId))?.amkByPassword === 'string' };
  const [bundle, pk] = await Promise.all([
    fetchBundle(state.userId),
    sb().from('passkeys').select('id', { count: 'exact', head: true }),
  ]);
  return { passkey: (pk.count ?? 0) > 0, password: typeof bundle?.amkByPassword === 'string' };
}

/**
 * Unlock a 'locked' session with one of the account's passkeys (WebAuthn PRF). Purely local: the
 * PRF output unwraps this credential's AMK wrap (readable by the owner only) — nothing about the
 * passkey or the keys is sent anywhere.
 */
export async function unlockWithPasskey(remember = rememberDevice): Promise<void> {
  const userId = state.userId;
  if (!userId) throw new Error('Not signed in');
  const creds = must(await sb().from('passkeys').select('id, credential_id, transports')) as
    { id: string; credential_id: string; transports: string[] }[];
  if (!creds.length) throw new Error('This account has no passkey yet.');
  const r = await evaluatePrf(clientRpId(), creds.map((c) => ({ id: c.credential_id, transports: c.transports })));
  if (!r) throw new KithwallCryptoError('decrypt_failed', 'This passkey cannot unlock your keys on this device.');
  const cred = creds.find((c) => c.credential_id === r.credentialId);
  const wrap = cred ? must(await sb().from('passkey_wraps').select('prf_salt, amk_wrap').eq('passkey_id', cred.id).maybeSingle()) as
    { prf_salt: string; amk_wrap: string } | null : null;
  if (!wrap) throw new KithwallCryptoError('decrypt_failed', 'This passkey has no key for this account.');
  const bundle = await fetchBundle(userId);
  if (!bundle) throw new Error('No keys found for this account');
  const u = unlockWithPrf(userId, bundle, r.credentialId, wrap.amk_wrap, r.output, wrap.prf_salt);
  r.output.fill(0);
  await becomeReady(userId, state.email, u, remember);
}

/** The owner confirmed they saved the current recovery phrase (enables removing the last passkey). */
export async function confirmRecoverySaved(): Promise<void> {
  must(await sb().rpc('mark_recovery_saved', { p_saved: true }));
}

async function fetchBundle(userId: string): Promise<KeyBundle | null> {
  const { data, error } = await sb().from('key_bundles').select('bundle').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  const bundle = (data?.bundle as KeyBundle | undefined) ?? null;
  if (bundle) void offlineStore.saveBundle(userId, bundle); // to unlock without a connection (lib/keys/offline)
  return bundle;
}

// Re-open the identity keys with an AMK restored from this device.
function unlockFromAmk(userId: string, bundle: KeyBundle, amkBytes: Uint8Array): Unlocked {
  return unlockWithAmk(userId, bundle, amkBytes);
}

/**
 * Starts the auth session for (synthetic address, authKey) and returns the user id. Passphrase accounts go
 * through the server (security re-review R-W3, lib/auth/account-impl.ts passphraseGrant), which mints the
 * session after a constant-cost check; the browser never uses GoTrue's password grant.
 */
export type PasswordGrant = (email: string, authKey: string) => Promise<string>;

export async function signIn(email: string, password: string, remember: boolean, grant: PasswordGrant): Promise<SessionStatus> {
  set({ error: null });
  const { authKey, passwordKEK } = await deriveFromPassword(email, password);
  const userId = await grant(email, authKey);
  const bundle = await fetchBundle(userId);
  if (!bundle) { set({ status: 'setup', userId, email }); return 'setup'; }
  const u = unlockWithPassword(userId, bundle, passwordKEK);
  await becomeReady(userId, email, u, remember);
  return state.status;
}

/** Unlock after a reload (session exists, keys don't). */
export async function unlock(password: string, remember: boolean): Promise<void> {
  if (!state.userId || !state.email) throw new Error('Not signed in');
  const { passwordKEK } = await deriveFromPassword(state.email, password);
  const bundle = await bundleFor(state.userId);
  if (!bundle) throw new Error('No keys found for this account');
  const u = unlockWithPassword(state.userId, bundle, passwordKEK);
  await becomeReady(state.userId, state.email, u, remember);
}

/**
 * Store a new key bundle (a new password/passphrase wrap or recovery key) through /api/account/bundle with a
 * proof-of-key signed by this identity (security re-review R-K-5: a session alone can't write bundles).
 */
async function putBundle(next: KeyBundle, signPriv: Uint8Array): Promise<void> {
  const { data, error } = await sb().rpc('create_key_challenge', { purpose: 'update_bundle' });
  if (error) throw new Error(error.code === 'P0429' ? 'Too many attempts. Please wait a little.' : error.message);
  const ch = (Array.isArray(data) ? data[0] : data) as { id: string; nonce: string } | undefined;
  if (!ch) throw new Error('No confirmation was issued. Please try again.');
  await authedPost('/api/account/bundle', { challengeId: ch.id, signature: signChallenge(signPriv, ch.nonce), bundle: next });
}

/** A new passphrase after recovery (lib/auth/recover-client.ts setNewPassphrase). */
export async function setNewPassword(userId: string, email: string, bundle: KeyBundle, u: Unlocked, newPassword: string) {
  const { authKey, passwordKEK } = await deriveFromPassword(email, newPassword);
  const next: KeyBundle = { ...bundle, amkByPassword: rewrapPassword(userId, u.amk, passwordKEK) };
  // Update the bundle first: if the auth update then fails, the old password still unlocks via recovery.
  await putBundle(next, u.identity.signPriv);
  const res = await sb().auth.updateUser({ password: authKey });
  if (res.error) throw new Error(res.error.message);
  await becomeReady(userId, email, u, false);
}

/** Replace the recovery phrase (old phrase stops working). Returns the new phrase. */
export async function newRecoveryPhrase(): Promise<{ phrase: string; rk: Uint8Array }> {
  const userId = me();
  const bundle = await fetchBundle(userId);
  if (!bundle || !unlocked) throw new Error('Locked');
  // The old phrase stops working: stop vouching for it until the new one is confirmed
  // (confirmRecoverySaved). Best effort for databases without the Kithwall 2 migration.
  await sb().rpc('mark_recovery_saved', { p_saved: false }).then(() => undefined, () => undefined);
  const r = rotateRecovery(userId, unlocked.amk);
  const next: KeyBundle = { ...bundle, amkByRecovery: r.amkByRecovery, rkCommitment: r.rkCommitment };
  await putBundle(next, unlocked.identity.signPriv);
  return { phrase: r.recoveryPhrase, rk: r.rk };
}

export { fetchBundle };

// ---------------------------------------------------------------------------------------------
// Safety centre hooks (docs/v2/03-safety.md). lib/safety listens for locks to forget revealed hidden
// chats and other per-unlock state; the app PIN unlocks through unlockWithDeviceAmk().
type LockListener = (reason: 'lock' | 'sign_out') => void;
const lockListeners = new Set<LockListener>();
export function onLock(fn: LockListener): () => void {
  lockListeners.add(fn);
  return () => { lockListeners.delete(fn); };
}
function emitLock(reason: 'lock' | 'sign_out') {
  lockListeners.forEach((l) => { try { l(reason); } catch { /* listeners must not block a lock */ } });
}

/** Enter 'ready' with an AMK opened on this device (the app PIN). Never re-saved as "remember me". */
export async function unlockWithDeviceAmk(amkBytes: Uint8Array): Promise<void> {
  const userId = state.userId;
  if (!userId) throw new Error('Not signed in');
  const bundle = await bundleFor(userId);
  if (!bundle) throw new Error('No keys found for this account');
  const u = unlockFromAmk(userId, bundle, amkBytes);
  await becomeReady(userId, state.email, u, false);
}

export async function lock(): Promise<void> {
  stopTracking();
  await keyring.stop();
  if (unlocked) unlocked.amk.fill(0);
  unlocked = null;
  pendingAmk = null;
  await deviceStore.clear();
  emitLock('lock');
  set({ status: state.userId ? 'locked' : 'signed_out' });
}

export async function signOut(): Promise<void> {
  stopTracking();
  await keyring.stop();
  if (unlocked) unlocked.amk.fill(0);
  unlocked = null;
  pendingAmk = null;
  await deviceStore.clear();
  // Nothing of this account stays for opening it offline (lib/keys/offline).
  await offlineStore.clear();
  emitLock('sign_out');
  await sb().auth.signOut({ scope: 'local' });
  markOffline(false);
  set({ status: 'signed_out', userId: null, email: null, profile: null, error: null });
}

export async function refreshProfile() {
  if (!state.userId) return;
  set({ profile: await loadProfile(state.userId) });
}

export { b64u };
