// Pure helpers for the transparency screens (no React, no app imports, so they're unit-testable).
import { b64u, verifyKeyChange, type KeyChange } from '@kithwall/crypto';

export interface KeyChangeRow { change: KeyChange; sig: string; created_at: string }

/**
 * Follows signed identity-key changes (public.key_changes) starting from the key I verified: each row
 * counts only if the key we have reached so far signed it. True when the chain ends at `current`, i.e.
 * every step was vouched for by the previous key (spec §2 "key changes are signed by the previous key").
 */
export function vouchedChain(verified: string, current: string, rows: KeyChangeRow[]): boolean {
  let k = verified;
  for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    try {
      if (verifyKeyChange(b64u.decode(k), r.change, r.sig)) k = r.change.newSignPub;
    } catch { /* malformed row: ignore */ }
  }
  return k === current;
}

/** "Chrome · Windows" from a user-agent string (product names only, no version numbers). */
export function uaSummary(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || null;
}
