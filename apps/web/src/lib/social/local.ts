'use client';
// Small per-user preferences kept only on this device (hidden stories, dismissed suggestions).
// Stored in localStorage encrypted with the cache key (spec §3.13), so they are unreadable
// without unlocking the account.
import { decryptBlob, encryptBlob } from '@kithwall/crypto';
import { useSyncExternalStore } from 'react';
import { cacheKey, getSession } from '../keys/session';

export interface SocialPrefs { hiddenPosts: string[]; hiddenPymk: string[] }

const MAX = 500;
const AAD = 'social-prefs';
const empty = (): SocialPrefs => ({ hiddenPosts: [], hiddenPymk: [] });

let cached: { user: string; prefs: SocialPrefs } | null = null;
let version = 0;
const listeners = new Set<() => void>();

function storageKey(user: string) { return `kw.social.${user}`; }

export function getPrefs(): SocialPrefs {
  const user = getSession().userId;
  if (!user) return empty();
  if (cached && cached.user === user) return cached.prefs;
  let prefs = empty();
  try {
    const raw = localStorage.getItem(storageKey(user));
    if (raw) {
      const parsed = JSON.parse(new TextDecoder().decode(decryptBlob(cacheKey(), raw, `${AAD}/${user}`))) as Partial<SocialPrefs>;
      prefs = {
        hiddenPosts: Array.isArray(parsed.hiddenPosts) ? parsed.hiddenPosts.filter((x) => typeof x === 'string') : [],
        hiddenPymk: Array.isArray(parsed.hiddenPymk) ? parsed.hiddenPymk.filter((x) => typeof x === 'string') : [],
      };
    }
  } catch { /* unreadable or locked: start fresh */ }
  cached = { user, prefs };
  return prefs;
}

export function updatePrefs(fn: (p: SocialPrefs) => SocialPrefs) {
  const user = getSession().userId;
  if (!user) return;
  const next = fn(getPrefs());
  next.hiddenPosts = next.hiddenPosts.slice(-MAX);
  next.hiddenPymk = next.hiddenPymk.slice(-MAX);
  cached = { user, prefs: next };
  try {
    localStorage.setItem(storageKey(user), encryptBlob(cacheKey(), new TextEncoder().encode(JSON.stringify(next)), `${AAD}/${user}`));
  } catch { /* storage full or locked: keep in memory */ }
  version++;
  listeners.forEach((l) => l());
}

export function usePrefsVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version, () => 0);
}

export const hidePost = (id: string) => updatePrefs((p) => ({ ...p, hiddenPosts: [...p.hiddenPosts.filter((x) => x !== id), id] }));
export const unhidePost = (id: string) => updatePrefs((p) => ({ ...p, hiddenPosts: p.hiddenPosts.filter((x) => x !== id) }));
export const hidePymk = (id: string) => updatePrefs((p) => ({ ...p, hiddenPymk: [...p.hiddenPymk.filter((x) => x !== id), id] }));
