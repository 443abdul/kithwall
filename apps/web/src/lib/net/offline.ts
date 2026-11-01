// "Did this fail because there is no connection (rather than being refused)?" Browsers throw a TypeError
// from fetch; supabase-js turns that into an error object whose message is "TypeError: Failed to fetch"
// (Chrome), "NetworkError when attempting to fetch resource." (Firefox) or "Load failed" (Safari).
// navigator.onLine only catches the obvious case: in a shutdown the phone is often still "online".
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof TypeError || e instanceof OfflineError) return true;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}

/** Thrown instead of trying the network while the session runs offline (knownOffline()). */
export class OfflineError extends Error {
  constructor() { super('offline'); this.name = 'OfflineError'; }
}

// Set by lib/keys/session while the app was opened without a connection (docs/v2/08-censorship.md §5).
// Writers that would otherwise wait for the network (with an expired access token supabase-js first
// retries the token refresh for ~25 s) go straight to their offline path; cleared once it is back.
let offline = false;
export function setKnownOffline(v: boolean): void { offline = v; }
export function knownOffline(): boolean { return offline; }

/**
 * The signed-in account as stored by supabase-js, read without any network request. With an expired access
 * token and no connection getSession() returns nothing (it can't refresh), although the session is still there.
 */
export function storedAuthUser(storageKey: string | undefined): { id: string; email: string | null } | null {
  if (!storageKey) return null;
  try {
    const raw = localStorage.getItem(storageKey);
    const s = raw ? JSON.parse(raw) as { user?: { id?: unknown; email?: unknown }; refresh_token?: unknown } : null;
    const id = s?.user?.id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || typeof s?.refresh_token !== 'string') return null;
    return { id, email: typeof s.user?.email === 'string' ? s.user.email : null };
  } catch { return null; }
}
