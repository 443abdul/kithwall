// Where to go after signing in (`/signin?next=…`). Only paths on this site are allowed (security review
// W1): `"/\t/evil.example"` used to pass a prefix check, and browsers drop tabs and newlines inside URLs,
// so it became the protocol-relative `//evil.example`. We refuse control characters and backslashes
// outright, then resolve the value against a fixed placeholder origin and keep it only if it stays on
// that origin, returning just the normalised path + query + hash.

const FALLBACK = '/home';
const BASE = 'https://kithwall.invalid';

/** The same-site path in `raw` (normalised), or null when it isn't one. Also used for notification taps. */
export function safePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(raw)) return null;
  if (raw[0] !== '/' || raw[1] === '/') return null;
  let u: URL;
  try { u = new URL(raw, BASE); } catch { return null; }
  if (u.origin !== BASE) return null;
  const out = `${u.pathname}${u.search}${u.hash}`;
  return out.startsWith('/') && !out.startsWith('//') ? out : null;
}

export function safeNext(raw: string | null | undefined): string {
  return safePath(raw) ?? FALLBACK;
}
