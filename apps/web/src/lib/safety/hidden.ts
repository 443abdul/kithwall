'use client';
// Hidden chats (docs/v2/03-safety.md §6).
//
// The set of hidden conversation ids lives ONLY in the user's encrypted vault (lib/settings.ts,
// namespace "safety"), never in plaintext on the server. Hidden chats disappear from the chat list,
// unread badges and push previews until they are revealed with the app PIN; revealing lasts until the
// app locks (or is concealed again by hand).
//
// API for other screens (the messages owner filters ChatList and badges through it):
//   useHiddenChats(): Set<string>   ids to leave out RIGHT NOW (empty while revealed). Stable reference.
//   useHiddenChatIds(): Set<string> every hidden id, revealed or not (e.g. to badge a revealed chat).
//   isRevealed() / useRevealed()    are hidden chats currently revealed?
//   isHiddenChat(id)                is this conversation hidden (revealed or not)?
//   hideChat(id) / unhideChat(id)   change the set (needs an app PIN to hide; see canHideChats()).
//   concealHiddenChats()            hide them again now.
// Revealing goes through components/safety/RevealHidden (asks for the app PIN).
import { useEffect, useSyncExternalStore } from 'react';
import { getSession, onLock, useSession } from '../keys/session';
import { vaultGet, vaultUpdate } from '../settings';
import { getAppLock } from './applock';
import { writeSwHidden } from './swmirror';

export interface SafetyVault {
  /** Hidden conversation ids. */
  hidden?: string[];
  /** Devices (by app-PIN salt) where a duress PIN is set. Only readable after a real unlock. */
  duress?: Record<string, boolean>;
}
export const SAFETY_NS = 'safety';

const EMPTY: ReadonlySet<string> = new Set();
let all: Set<string> = new Set();
let concealed: ReadonlySet<string> = EMPTY;
let revealed = false;
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Set<string>, nextRevealed = revealed) {
  all = next;
  revealed = nextRevealed;
  concealed = revealed || !all.size ? EMPTY : new Set(all);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

onLock((reason) => {
  if (reason === 'sign_out') { loadedFor = null; publish(new Set(), false); }
  else publish(all, false);
});

/** Load the hidden set from the vault (once per unlocked account). */
export function loadHiddenChats(force = false): Promise<void> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return Promise.resolve();
  if (!force && loadedFor === s.userId) return Promise.resolve();
  loading ??= (async () => {
    const v = await vaultGet<SafetyVault>(SAFETY_NS).catch(() => undefined);
    loadedFor = s.userId;
    const ids = new Set((v?.hidden ?? []).filter((x) => typeof x === 'string'));
    publish(ids);
    await writeSwHidden([...ids]).catch(() => undefined);
  })().finally(() => { loading = null; });
  return loading;
}

function useLoaded() {
  const { status, userId } = useSession();
  useEffect(() => { if (status === 'ready' && userId) void loadHiddenChats(); }, [status, userId]);
}

/** Conversation ids to leave out of lists, badges and previews right now (empty while revealed). */
export function useHiddenChats(): Set<string> {
  useLoaded();
  return useSyncExternalStore(subscribe, () => concealed, () => EMPTY) as Set<string>;
}

/** Every hidden conversation id (also while revealed). */
export function useHiddenChatIds(): Set<string> {
  useLoaded();
  return useSyncExternalStore(subscribe, () => all, () => EMPTY as Set<string>);
}

export function isRevealed(): boolean { return revealed; }
export function useRevealed(): boolean {
  return useSyncExternalStore(subscribe, () => revealed, () => false);
}
export function isHiddenChat(id: string): boolean { return all.has(id); }

/** Hiding chats needs an app PIN on this device (that's what reveals them). */
export function canHideChats(): boolean { return getAppLock().pin === 'set'; }

async function update(fn: (ids: Set<string>) => void): Promise<void> {
  const saved = await vaultUpdate<SafetyVault>(SAFETY_NS, (prev) => {
    const ids = new Set(prev?.hidden ?? []);
    fn(ids);
    return { ...(prev ?? {}), hidden: [...ids] };
  });
  const ids = new Set(saved.hidden ?? []);
  publish(ids);
  await writeSwHidden([...ids]).catch(() => undefined);
}

export async function hideChat(id: string): Promise<void> {
  if (!canHideChats()) throw new Error('app_pin_required');
  await update((ids) => { ids.add(id); });
}
export async function unhideChat(id: string): Promise<void> {
  await update((ids) => { ids.delete(id); });
}

/** Called by components/safety/RevealHidden after the app PIN was checked. */
export function revealHiddenChats() { publish(all, true); }
export function concealHiddenChats() { publish(all, false); }

// ---------------------------------------------------------------------------------------------
// Duress flag (see applock.pinSettings)

export async function duressSetHere(salt: string): Promise<boolean> {
  const v = await vaultGet<SafetyVault>(SAFETY_NS).catch(() => undefined);
  return !!v?.duress?.[salt];
}
export async function noteDuressHere(salt: string, on: boolean): Promise<void> {
  await vaultUpdate<SafetyVault>(SAFETY_NS, (prev) => {
    const duress = { ...(prev?.duress ?? {}) };
    if (on) duress[salt] = true; else delete duress[salt];
    return { ...(prev ?? {}), duress };
  });
}
