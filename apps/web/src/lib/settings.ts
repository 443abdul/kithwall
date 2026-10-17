'use client';
// Per-user preferences, stored ONLY encrypted: one vault blob per user (table `vault`), encrypted with
// vaultKey = HKDF(AMK, "kithwall/v1/vault") and AAD "vault/<user id>". The server never sees them.
//
// Contract used by others (keep these names):
//   chatVisible() / setChatVisible(v)   — whether friends can see me online (D's chat)
//   defaultAudience()                    — 'friends' | 'self' | 'public' for new posts (B's publisher)
// Reads are synchronous from an in-memory copy; loadSettings() refreshes it from the vault after unlock.
// A tiny non-sensitive mirror (chat visibility, default audience) lives in localStorage so the first
// render after a reload is right before the vault is decrypted.
import { decryptBlob, deriveVaultKey, encryptBlob } from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { sb, must } from './supabase';
import { amk, getSession, me } from './keys/session';

export type DefaultAudience = 'friends' | 'self' | 'public';

export interface EmailPrefs {
  /** Content-free emails ("You have new activity on Kithwall") — never include names or text. */
  activity: boolean;
  friendRequests: boolean;
  messages: boolean;
  security: boolean; // recovery requests, new trusted-friend requests (always recommended)
}

export interface Settings {
  chatVisible: boolean;
  defaultAudience: DefaultAudience;
  email: EmailPrefs;
  language: 'en-US';
}

export const DEFAULT_SETTINGS: Settings = {
  chatVisible: true,
  defaultAudience: 'friends',
  email: { activity: false, friendRequests: true, messages: false, security: true },
  language: 'en-US',
};

const MIRROR = 'kw.settings.mirror';
const LEGACY_CHAT = 'kw.chatVisible';
const listeners = new Set<() => void>();
let current: Settings = readMirror();
let loadedFor: string | null = null;

function readMirror(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, email: { ...DEFAULT_SETTINGS.email } };
  try {
    const m = JSON.parse(localStorage.getItem(MIRROR) ?? '{}') as Partial<Settings>;
    if (typeof m.chatVisible === 'boolean') s.chatVisible = m.chatVisible;
    else if (localStorage.getItem(LEGACY_CHAT) === 'false') s.chatVisible = false;
    if (m.defaultAudience === 'friends' || m.defaultAudience === 'self' || m.defaultAudience === 'public') s.defaultAudience = m.defaultAudience;
  } catch { /* SSR or storage blocked */ }
  return s;
}

function publish(next: Settings) {
  current = next;
  try {
    localStorage.setItem(MIRROR, JSON.stringify({ chatVisible: next.chatVisible, defaultAudience: next.defaultAudience }));
    localStorage.setItem(LEGACY_CHAT, String(next.chatVisible));
  } catch { /* ignore */ }
  listeners.forEach((l) => l());
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('kw:settings'));
}

export function getSettings(): Settings { return current; }
export function chatVisible(): boolean { return current.chatVisible; }
export function defaultAudience(): DefaultAudience { return current.defaultAudience; }

export function setChatVisible(v: boolean) {
  publish({ ...current, chatVisible: v });
  void saveSettings({ chatVisible: v }).catch((e) => console.warn('settings save failed', e));
}

export function useSettings(): Settings {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current, () => DEFAULT_SETTINGS);
}

// ---------------------------------------------------------------------------------------
// The vault: { v: 1, settings?: Settings, [namespace]: unknown }. Other features may keep their own
// namespaces with vaultGet/vaultUpdate. Writes use optimistic concurrency on updated_at.

export interface VaultData { v: 1; settings?: Partial<Settings>; [ns: string]: unknown }
interface VaultRow { blob: string; updated_at: string }

const aad = (userId: string) => `vault/${userId}`;

async function readRow(): Promise<{ data: VaultData; updatedAt: string | null }> {
  const row = (await sb().from('vault').select('blob, updated_at').eq('user_id', me()).maybeSingle()).data as VaultRow | null;
  if (!row) return { data: { v: 1 }, updatedAt: null };
  const bytes = decryptBlob(deriveVaultKey(amk()), row.blob, aad(me()));
  return { data: JSON.parse(new TextDecoder().decode(bytes)) as VaultData, updatedAt: row.updated_at };
}

export async function vaultGet<T = unknown>(ns: string): Promise<T | undefined> {
  return (await readRow()).data[ns] as T | undefined;
}

/** Read-modify-write one namespace of the vault. Retries if another tab wrote in between. */
export async function vaultUpdate<T>(ns: string, fn: (prev: T | undefined) => T): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, updatedAt } = await readRow();
    const nextVal = fn(data[ns] as T | undefined);
    const next: VaultData = { ...data, v: 1, [ns]: nextVal };
    const blob = encryptBlob(deriveVaultKey(amk()), new TextEncoder().encode(JSON.stringify(next)), aad(me()));
    const now = new Date().toISOString();
    if (updatedAt === null) {
      const ins = await sb().from('vault').insert({ user_id: me(), blob, updated_at: now });
      if (!ins.error) return nextVal;
      if (ins.error.code !== '23505') throw new Error(ins.error.message);
    } else {
      const upd = must(await sb().from('vault').update({ blob, updated_at: now }).eq('user_id', me()).eq('updated_at', updatedAt).select('user_id')) as unknown[];
      if (upd.length) return nextVal;
    }
  }
  throw new Error('Your settings were changed in another window. Please try again.');
}

function merge(s: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS, ...(s ?? {}),
    email: { ...DEFAULT_SETTINGS.email, ...(s?.email ?? {}) },
  } as Settings;
}

/** Decrypt my settings from the vault (call once keys are unlocked). */
export async function loadSettings(force = false): Promise<Settings> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return current;
  if (!force && loadedFor === s.userId) return current;
  const data = await vaultGet<Partial<Settings>>('settings');
  loadedFor = s.userId;
  publish(merge(data ?? { chatVisible: current.chatVisible, defaultAudience: current.defaultAudience }));
  return current;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const saved = await vaultUpdate<Partial<Settings>>('settings', (prev) => {
    const base = merge(prev);
    return { ...base, ...patch, email: { ...base.email, ...(patch.email ?? {}) } };
  });
  publish(merge(saved));
  return current;
}
