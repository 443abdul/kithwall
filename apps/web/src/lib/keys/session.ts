'use client';
// Client session: Supabase auth + the user's unlocked keys (held in memory only).
// See docs/03-spec.md §3.1–3.4 and §3.13.
import {
  b64u, createKeyBundle, deriveFromPassword, deriveCacheKey, unlockWithPassword, unlockWithRecoveryPhrase,
  rewrapPassword, rotateRecovery, unlockWithAmk, type Identity, type KeyBundle, type Unlocked,
} from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { sb, must } from '../supabase';
import type { ProfileRow } from '../types';
import { keyring } from './keyring';
import { deviceStore } from './device';

export type SessionStatus =
  | 'loading'     // checking for an existing session
  | 'signed_out'
  | 'locked'      // Supabase session exists but keys are not in memory (enter password to unlock)
  | 'setup'       // signed in, keys not created yet (first login after confirming email)
  | 'ready';

export interface SessionState {
  status: SessionStatus;
  userId: string | null;
  email: string | null;
  profile: ProfileRow | null;
  error: string | null;
}

let state: SessionState = { status: 'loading', userId: null, email: null, profile: null, error: null };
let unlocked: Unlocked | null = null;
let pendingKEK: Uint8Array | null = null; // only between first login and key setup
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

async function loadProfile(userId: string): Promise<ProfileRow | null> {
  const { data } = await sb().from('profiles').select('*').eq('id', userId).maybeSingle();
  return (data as ProfileRow | null) ?? null;
}

async function becomeReady(userId: string, email: string | null, u: Unlocked, remember: boolean) {
  unlocked = u;
  pendingKEK = null;
  if (remember) await deviceStore.save(userId, u.amk).catch(() => undefined);
  const profile = await loadProfile(userId);
  if (!profile) { set({ status: 'setup', userId, email, error: null }); return; }
  set({ status: 'ready', userId, email, profile, error: null });
  await keyring.start(userId, u);
}

/** Restore on page load. */
export async function initSession(): Promise<void> {
  const { data } = await sb().auth.getSession();
  const s = data.session;
  if (!s) { set({ status: 'signed_out' }); return; }
  const userId = s.user.id;
  const email = s.user.email ?? null;
  const bundle = await fetchBundle(userId);
  if (!bundle) { set({ status: 'setup', userId, email }); return; }
  const amkBytes = await deviceStore.load(userId).catch(() => null);
  if (amkBytes) {
    try {
      const u = unlockFromAmk(userId, bundle, amkBytes);
      await becomeReady(userId, email, u, false);
      return;
    } catch { await deviceStore.clear(); }
  }
  set({ status: 'locked', userId, email });
}

async function fetchBundle(userId: string): Promise<KeyBundle | null> {
  const { data, error } = await sb().from('key_bundles').select('bundle').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.bundle as KeyBundle | undefined) ?? null;
}

// Re-open the identity keys with an AMK restored from this device.
function unlockFromAmk(userId: string, bundle: KeyBundle, amkBytes: Uint8Array): Unlocked {
  return unlockWithAmk(userId, bundle, amkBytes);
}

export interface SignUpInput { email: string; password: string; altcha?: string; inviteCode?: string }

export async function signUp(input: SignUpInput): Promise<{ needsConfirmation: boolean }> {
  const { authKey } = await deriveFromPassword(input.email, input.password);
  const redirect = `${location.origin}/welcome${input.inviteCode ? `?invite=${encodeURIComponent(input.inviteCode)}` : ''}`;
  const res = await sb().auth.signUp({
    email: input.email,
    password: authKey,
    options: { emailRedirectTo: redirect, data: input.altcha ? { altcha: input.altcha } : {} },
  });
  if (res.error) throw new Error(res.error.message);
  return { needsConfirmation: !res.data.session };
}

export async function signIn(email: string, password: string, remember: boolean): Promise<SessionStatus> {
  set({ error: null });
  const { authKey, passwordKEK } = await deriveFromPassword(email, password);
  const res = await sb().auth.signInWithPassword({ email, password: authKey });
  if (res.error || !res.data.user) throw new Error(res.error?.message === 'Invalid login credentials'
    ? 'The email or password you entered is incorrect.' : (res.error?.message ?? 'Login failed'));
  const userId = res.data.user.id;
  const bundle = await fetchBundle(userId);
  if (!bundle) { pendingKEK = passwordKEK; set({ status: 'setup', userId, email }); return 'setup'; }
  const u = unlockWithPassword(userId, bundle, passwordKEK);
  await becomeReady(userId, email, u, remember);
  return state.status;
}

/** Unlock after a reload (session exists, keys don't). */
export async function unlock(password: string, remember: boolean): Promise<void> {
  if (!state.userId || !state.email) throw new Error('Not signed in');
  const { passwordKEK } = await deriveFromPassword(state.email, password);
  const bundle = await fetchBundle(state.userId);
  if (!bundle) throw new Error('No keys found for this account');
  const u = unlockWithPassword(state.userId, bundle, passwordKEK);
  await becomeReady(state.userId, state.email, u, remember);
}

/**
 * First login: create keys, upload the bundle, create the profile.
 * Returns the 24-word recovery phrase, which the UI must show and have the user confirm.
 */
export async function completeSetup(args: { password: string; username: string; directoryName?: string | null }): Promise<string> {
  const userId = me();
  const email = state.email ?? '';
  // Re-derive and prove the password is right before creating keys with it.
  const derived = await deriveFromPassword(email, args.password);
  const check = await sb().auth.signInWithPassword({ email, password: derived.authKey });
  if (check.error) throw new Error('That password is not correct.');
  const kek = derived.passwordKEK;

  const { bundle, unlocked: u, recoveryPhrase } = createKeyBundle(userId, kek);
  must(await sb().from('key_bundles').insert({ user_id: userId, bundle }));
  const ins = await sb().from('profiles').insert({
    id: userId,
    username: args.username.toLowerCase(),
    discoverable: !!args.directoryName,
    display_name_public: args.directoryName || null,
    sign_pub: bundle.signPub,
    kx_pub: bundle.kxPub,
  });
  if (ins.error) {
    // Roll back the bundle so the user can retry with another username.
    await sb().from('key_bundles').delete().eq('user_id', userId);
    throw new Error(ins.error.code === '23505' ? 'That username is taken.' : ins.error.message);
  }
  await becomeReady(userId, email, u, false);
  return recoveryPhrase;
}

/** Forgot-password path: Supabase recovery session + 24 words → new password. */
export async function recoverWithPhrase(phrase: string, newPassword: string): Promise<void> {
  const { data } = await sb().auth.getUser();
  const user = data.user;
  if (!user?.email) throw new Error('Open the password reset link from your email first.');
  const bundle = await fetchBundle(user.id);
  if (!bundle) throw new Error('No keys found for this account');
  const u = unlockWithRecoveryPhrase(user.id, bundle, phrase);
  await setNewPassword(user.id, user.email, bundle, u, newPassword);
}

/** Used by password change, phrase recovery and trusted-friend recovery. */
export async function setNewPassword(userId: string, email: string, bundle: KeyBundle, u: Unlocked, newPassword: string) {
  const { authKey, passwordKEK } = await deriveFromPassword(email, newPassword);
  const next: KeyBundle = { ...bundle, amkByPassword: rewrapPassword(userId, u.amk, passwordKEK) };
  // Update the bundle first: if the auth update then fails, the old password still unlocks via recovery.
  must(await sb().from('key_bundles').update({ bundle: next, updated_at: new Date().toISOString() }).eq('user_id', userId));
  const res = await sb().auth.updateUser({ password: authKey });
  if (res.error) throw new Error(res.error.message);
  await becomeReady(userId, email, u, false);
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const userId = me(); const email = state.email ?? '';
  const bundle = await fetchBundle(userId);
  if (!bundle) throw new Error('No keys');
  const { passwordKEK } = await deriveFromPassword(email, oldPassword);
  const u = unlockWithPassword(userId, bundle, passwordKEK); // throws if wrong
  await setNewPassword(userId, email, bundle, u, newPassword);
}

/** Replace the recovery phrase (old phrase stops working). Returns the new phrase. */
export async function newRecoveryPhrase(): Promise<{ phrase: string; rk: Uint8Array }> {
  const userId = me();
  const bundle = await fetchBundle(userId);
  if (!bundle || !unlocked) throw new Error('Locked');
  const r = rotateRecovery(userId, unlocked.amk);
  const next: KeyBundle = { ...bundle, amkByRecovery: r.amkByRecovery, rkCommitment: r.rkCommitment };
  must(await sb().from('key_bundles').update({ bundle: next, updated_at: new Date().toISOString() }).eq('user_id', userId));
  return { phrase: r.recoveryPhrase, rk: r.rk };
}

export { fetchBundle };

export async function lock(): Promise<void> {
  await keyring.stop();
  unlocked = null;
  await deviceStore.clear();
  set({ status: state.userId ? 'locked' : 'signed_out' });
}

export async function signOut(): Promise<void> {
  await keyring.stop();
  unlocked = null; pendingKEK = null;
  await deviceStore.clear();
  await sb().auth.signOut({ scope: 'local' });
  set({ status: 'signed_out', userId: null, email: null, profile: null });
}

export async function refreshProfile() {
  if (!state.userId) return;
  set({ profile: await loadProfile(state.userId) });
}

export { b64u };
