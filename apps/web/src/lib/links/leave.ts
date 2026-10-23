'use client';
// "Leaving Kithwall": every user-supplied link (posts, comments, chats, profiles, notes, link cards) is an
// <ExternalLink> (components/links/ExternalLink.tsx). A tap asks this store to show the confirmation sheet,
// which LeaveHost (mounted once in V2Root) renders. This module is tiny on purpose: the analyser (with the
// Public Suffix List) and the sheet are only loaded when a link is tapped (or hovered / focused).
//
// Opening: the system browser in the Android / iOS app (KithwallShell.openExternal, https only), else a new
// tab with no opener and no referrer.
import { useSyncExternalStore } from 'react';
import { isNative, nativePlugin } from '@/lib/native';

/** rel for every user-supplied link. The page's Referrer-Policy is already no-referrer (next.config.ts). */
export const EXTERNAL_REL = 'noopener noreferrer nofollow ugc';

/** Only http(s) URLs are ever links; data:, javascript:, file: … stay plain text. */
export function isNavigableHref(href: string | null | undefined): href is string {
  return !!href && /^https?:\/\/[^\s]+$/i.test(href.trim());
}

const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
/** Keep a left-to-right address intact inside a translated (possibly right-to-left) sentence. */
export const isolate = (s: string) => `${FSI}${s}${PDI}`;

export interface LeaveRequest { id: number; href: string; text: string | null }

let current: LeaveRequest | null = null;
let seq = 0;
let hosts: number[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * LeaveHost registers itself; without a host (e.g. a page outside V2Root) links open normally. V2Roots can
 * nest (lock screens inside the app layout): only the first host renders the sheet.
 */
export function registerLeaveHost(id: number): () => void {
  hosts = [...hosts, id];
  emit();
  return () => { hosts = hosts.filter((h) => h !== id); emit(); };
}

export function useActiveLeaveHost(): number | null {
  return useSyncExternalStore(subscribe, () => hosts[0] ?? null, () => null);
}

/** Ask to open `href` (the visible link text helps spot "text says paypal.com, link goes elsewhere"). */
export function requestLeave(href: string, text?: string | null): boolean {
  if (!hosts.length) return false;
  current = { id: ++seq, href, text: text?.trim() || null };
  emit();
  return true;
}

export function closeLeave(): void {
  current = null;
  emit();
}

export function useLeaveRequest(): LeaveRequest | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

let prefetched = false;
/** Start loading the sheet (and the analyser) when a link is hovered or focused, so the tap is instant. */
export function prefetchLeaveSheet(): void {
  if (prefetched) return;
  prefetched = true;
  void import('@/components/links/LeaveSheet').catch(() => { prefetched = false; });
}

// ---------------------------------------------------------------------------------------------
// "Don't ask again for this site" — registrable domains, on this device only (cleared by panic wipe with
// the rest of localStorage). Never offered for links with warnings.

const TRUST_KEY = 'kw.links.trusted';
const MAX_TRUSTED = 200;

export function trustedSites(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TRUST_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_TRUSTED) : [];
  } catch { return []; }
}

export function isTrustedSite(domain: string): boolean {
  return trustedSites().includes(domain.toLowerCase());
}

export function trustSite(domain: string): void {
  const d = domain.toLowerCase();
  try {
    const list = trustedSites().filter((x) => x !== d);
    localStorage.setItem(TRUST_KEY, JSON.stringify([d, ...list].slice(0, MAX_TRUSTED)));
  } catch { /* storage unavailable: just ask again next time */ }
}

export function forgetTrustedSites(): void {
  try { localStorage.removeItem(TRUST_KEY); } catch { /* nothing stored */ }
}

// ---------------------------------------------------------------------------------------------

/** Open a checked URL outside Kithwall. Synchronous on the web, so the tap's user activation is kept. */
export function openOutside(url: string): void {
  if (isNative() && /^https:\/\//i.test(url)) {
    nativePlugin('KithwallShell').then((s) => s.openExternal({ url })).catch(() => openInTab(url));
    return;
  }
  openInTab(url);
}

function openInTab(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = EXTERNAL_REL;
  a.referrerPolicy = 'no-referrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
