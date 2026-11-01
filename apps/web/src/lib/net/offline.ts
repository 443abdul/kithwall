// "Did this fail because there is no connection (rather than being refused)?" Browsers throw a TypeError
// from fetch; supabase-js turns that into an error object whose message is "TypeError: Failed to fetch"
// (Chrome), "NetworkError when attempting to fetch resource." (Firefox) or "Load failed" (Safari).
// navigator.onLine only catches the obvious case: in a shutdown the phone is often still "online".
export function isOfflineError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}
