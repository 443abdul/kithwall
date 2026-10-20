'use client';
// App lock, duress PIN and decoy mode (docs/v2/03-safety.md §2–3).
//
//  - The app PIN unwraps a device-local wrap of the AMK (lib/safety/pin.ts), stored under a
//    non-extractable device key (lib/keys/device.ts pinStore). While a PIN is set, "keep me signed in"
//    is off: every open of the app, and every lock, needs the PIN (or a passkey/passphrase).
//  - Locking stops the keyring, zeroes the AMK and reloads the page, so nothing decrypted survives in
//    memory (query caches, decrypted names, message caches).
//  - The duress PIN opens a decoy: no keys are loaded and the real screens are never mounted
//    (components/shell/AppGate renders components/safety/DecoyApp instead). Optionally it also wipes
//    this device in the background.
import { useSyncExternalStore } from 'react';
import { getSession, lock, me, amk as currentAmk, unlockWithDeviceAmk } from '../keys/session';
import { pinStore, type DuressAction, type PinRecord } from '../keys/device';
import { createPinWrap, openPinWrap, setDuressPin } from './pin';
import { attemptWait, noteFailure, noteSuccess } from './limiter';
import { wipeThisDevice } from './wipe';

// ---------------------------------------------------------------------------------------------
// Store

export type PinState = 'unknown' | 'none' | 'set';
export interface DecoyInfo { name: string; handle: string }

interface LockState { userId: string | null; pin: PinState; decoy: DecoyInfo | null }
let state: LockState = { userId: null, pin: 'unknown', decoy: null };
const listeners = new Set<() => void>();
function set(patch: Partial<LockState>) { state = { ...state, ...patch }; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useAppLock(): LockState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
export const getAppLock = () => state;

/** Re-read whether this device has an app PIN for this account. */
export async function refreshPinState(userId: string | null): Promise<PinState> {
  if (!userId) { set({ userId: null, pin: 'none' }); return 'none'; }
  if (state.userId !== userId) set({ userId, pin: 'unknown' });
  const has = await pinStore.has(userId).catch(() => false);
  set({ userId, pin: has ? 'set' : 'none' });
  return has ? 'set' : 'none';
}

// ---------------------------------------------------------------------------------------------
// Device-local preferences (needed before the vault can be decrypted, so kept in localStorage; they
// say nothing about content).

export interface LockPrefs {
  /** Lock after this many minutes without interaction (0: never). */
  idleMinutes: 0 | 1 | 5 | 15 | 60;
  /** Lock as soon as the app goes to the background. */
  onHide: boolean;
}
export interface ExitPrefs {
  enabled: boolean;
  /** Always-visible shield button. */
  button: boolean;
  /** Tap the Kithwall logo three times quickly (or press Esc three times). */
  tripleTap: boolean;
  action: 'wipe' | 'lock';
  /** Where to go: one of NEUTRAL_SITES. */
  site: string;
}

export const NEUTRAL_SITES = [
  'https://www.wikipedia.org/',
  'https://www.bbc.com/weather',
  'https://www.google.com/',
] as const;

const LOCK_KEY = 'kw.safety.lock';
const EXIT_KEY = 'kw.safety.exit';
export const DEFAULT_LOCK: LockPrefs = { idleMinutes: 0, onHide: false };
export const DEFAULT_EXIT: ExitPrefs = { enabled: false, button: true, tripleTap: true, action: 'wipe', site: NEUTRAL_SITES[0] };

function readJson<T extends object>(key: string, def: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<T> | null;
    return v && typeof v === 'object' ? { ...def, ...v } : def;
  } catch { return def; }
}
let lockPrefs: LockPrefs | null = null;
let exitPrefs: ExitPrefs | null = null;
const prefListeners = new Set<() => void>();
const subscribePrefs = (l: () => void) => { prefListeners.add(l); return () => { prefListeners.delete(l); }; };

export function getLockPrefs(): LockPrefs {
  lockPrefs ??= readJson(LOCK_KEY, DEFAULT_LOCK);
  return lockPrefs;
}
export function getExitPrefs(): ExitPrefs {
  exitPrefs ??= readJson(EXIT_KEY, DEFAULT_EXIT);
  if (!(NEUTRAL_SITES as readonly string[]).includes(exitPrefs.site)) exitPrefs = { ...exitPrefs, site: NEUTRAL_SITES[0] };
  return exitPrefs;
}
export function setLockPrefs(p: LockPrefs) {
  lockPrefs = p;
  try { localStorage.setItem(LOCK_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
  prefListeners.forEach((l) => l());
}
export function setExitPrefs(p: ExitPrefs) {
  exitPrefs = p;
  try { localStorage.setItem(EXIT_KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
  prefListeners.forEach((l) => l());
}
export function useLockPrefs(): LockPrefs {
  return useSyncExternalStore(subscribePrefs, getLockPrefs, () => DEFAULT_LOCK);
}
export function useExitPrefs(): ExitPrefs {
  return useSyncExternalStore(subscribePrefs, getExitPrefs, () => DEFAULT_EXIT);
}

// ---------------------------------------------------------------------------------------------
// Setting up

export class PinError extends Error {
  constructor(public code: string) { super(code); }
}

function codeOf(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  return /^pin_/.test(m) ? m : 'unknown';
}

async function requireRecord(): Promise<PinRecord> {
  const rec = await pinStore.load(me());
  if (!rec) throw new PinError('pin_not_set');
  return rec;
}

async function checkCurrent(rec: PinRecord, pin: string): Promise<void> {
  const r = await guardedOpen(rec, pin);
  if (r !== 'real') throw new PinError(r === 'wait' ? 'pin_wait' : 'pin_wrong');
}

/** Turn on the app PIN for this device (needs the keys unlocked). */
export async function enableAppLock(pin: string, opts: { wipeAfter: number | null }): Promise<void> {
  const userId = me();
  let wrap;
  try { wrap = await createPinWrap(userId, currentAmk(), pin); } catch (e) { throw new PinError(codeOf(e)); }
  await pinStore.save({ userId, wrap, duressAction: 'none', decoyName: '', wipeAfter: opts.wipeAfter, handle: getSession().profile?.username ?? '' });
  await pinStore.attempts.save(userId, noteSuccess());
  if (getLockPrefs().idleMinutes === 0) setLockPrefs({ ...getLockPrefs(), idleMinutes: 5 });
  await refreshPinState(userId);
}

export async function changeAppPin(currentPin: string, nextPin: string): Promise<void> {
  const rec = await requireRecord();
  await checkCurrent(rec, currentPin);
  let wrap;
  try { wrap = await createPinWrap(rec.userId, currentAmk(), nextPin, {}, rec.wrap); } catch (e) { throw new PinError(codeOf(e)); }
  await pinStore.save({ ...rec, wrap });
}

/** Turn the app PIN off (needs the current PIN). The duress PIN goes with it. */
export async function disableAppLock(currentPin: string): Promise<void> {
  const rec = await requireRecord();
  await checkCurrent(rec, currentPin);
  await pinStore.clear();
  await refreshPinState(rec.userId);
}

/** Set or clear the duress PIN and what it does. */
export async function configureDuress(args: { duressPin?: string | null; action?: DuressAction; decoyName?: string }): Promise<void> {
  const rec = await requireRecord();
  let wrap = rec.wrap;
  if (args.duressPin !== undefined) {
    try { wrap = await setDuressPin(rec.userId, rec.wrap, args.duressPin); } catch (e) { throw new PinError(codeOf(e)); }
  }
  await pinStore.save({
    ...rec, wrap,
    duressAction: args.action ?? rec.duressAction,
    decoyName: args.decoyName !== undefined ? args.decoyName.trim().slice(0, 60) : rec.decoyName,
    handle: rec.handle || getSession().profile?.username || '',
  });
}

export async function setWipeAfter(n: number | null): Promise<void> {
  const rec = await requireRecord();
  await pinStore.save({ ...rec, wipeAfter: n });
}

/** Non-secret settings of the current record, for the settings screen. */
// Whether a duress PIN is set can't be read from the device record (by design: with or without one,
// the record looks the same). The settings screen remembers it in the encrypted vault instead, keyed
// by this device's PIN salt, so only someone who has unlocked the real account can see it.
export async function pinSettings(): Promise<{ salt: string; duressAction: DuressAction; decoyName: string; wipeAfter: number | null } | null> {
  const s = getSession();
  if (!s.userId) return null;
  const rec = await pinStore.load(s.userId).catch(() => null);
  if (!rec) return null;
  return { salt: rec.wrap.salt, duressAction: rec.duressAction, decoyName: rec.decoyName, wipeAfter: rec.wipeAfter };
}

// ---------------------------------------------------------------------------------------------
// Entering a PIN

type GuardResult = 'real' | 'duress' | 'wrong' | 'wait' | 'wiped';
let lastAmk: Uint8Array | null = null;

async function guardedOpen(rec: PinRecord, pin: string): Promise<GuardResult> {
  const now = Date.now();
  const st = await pinStore.attempts.load(rec.userId);
  if (attemptWait(st, now) > 0) return 'wait';
  const r = await openPinWrap(rec.userId, rec.wrap, pin);
  if (r.kind === 'wrong') {
    const f = noteFailure(st, Date.now(), rec.wipeAfter);
    await pinStore.attempts.save(rec.userId, f.state);
    if (f.wipe) { await wipeThisDevice(); return 'wiped'; }
    return 'wrong';
  }
  await pinStore.attempts.save(rec.userId, noteSuccess());
  if (r.kind === 'real') { lastAmk = r.amk; return 'real'; }
  return 'duress';
}

/** Milliseconds until another PIN attempt is allowed on this device. */
export async function pinWait(): Promise<number> {
  const s = getSession();
  if (!s.userId) return 0;
  return attemptWait(await pinStore.attempts.load(s.userId), Date.now());
}

export type UnlockResult = 'ok' | 'wrong' | 'wait' | 'wiped' | 'decoy';

/**
 * The lock screen. Real PIN: unlock. Duress PIN: open the decoy (and wipe in the background if set).
 * Both look the same to an onlooker; a wrong PIN counts towards the delay and the optional wipe.
 */
export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  const s = getSession();
  if (!s.userId) return 'wrong';
  const rec = await pinStore.load(s.userId).catch(() => null);
  if (!rec) return 'wrong';
  const r = await guardedOpen(rec, pin);
  if (r === 'real') {
    const a = lastAmk; lastAmk = null;
    if (!a) return 'wrong';
    await unlockWithDeviceAmk(a);
    return 'ok';
  }
  if (r === 'duress') {
    enterDecoy({ name: rec.decoyName || rec.handle, handle: rec.handle });
    if (rec.duressAction === 'wipe') void wipeThisDevice().catch(() => undefined);
    return 'decoy';
  }
  return r;
}

/** Check the app PIN while unlocked (revealing hidden chats). The duress PIN counts as wrong here. */
export async function verifyAppPin(pin: string): Promise<'ok' | 'wrong' | 'wait' | 'wiped'> {
  const s = getSession();
  if (!s.userId) return 'wrong';
  const rec = await pinStore.load(s.userId).catch(() => null);
  if (!rec) return 'wrong';
  const r = await guardedOpen(rec, pin);
  if (r === 'real') { lastAmk?.fill(0); lastAmk = null; return 'ok'; }
  return r === 'duress' ? 'wrong' : r;
}

// ---------------------------------------------------------------------------------------------
// Decoy and locking

export function enterDecoy(info: DecoyInfo) { set({ decoy: info }); }
export function leaveDecoy() { set({ decoy: null }); }

/**
 * Lock now: drop the keys and reload, so nothing decrypted stays in this tab's memory. The next
 * screen is the PIN pad (or the passkey/passphrase unlock when no PIN is set).
 */
export async function lockNow(): Promise<void> {
  set({ decoy: null });
  if (getSession().status === 'ready') await lock();
  location.reload();
}
