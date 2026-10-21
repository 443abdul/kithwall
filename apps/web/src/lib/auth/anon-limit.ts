import 'server-only';
// Database-backed rate limits for routes used without an account (security review L6 / W4). The
// per-instance memory limiters reset on every cold start and differ per instance; these are shared.
// Keys are a SHA-256 of the scope and its parts (a daily-rotating IP tag, maybe an account id), so the
// table never holds an address or an id (kw.anon_rate_events, supabase/migrations/20261028010500).
import { createHash } from 'node:crypto';
import { admin } from './server';
import { ipTag } from './passkey-server';

export function rateKey(scope: string, ...parts: string[]): string {
  return createHash('sha256').update([`kithwall/anon-rate/${scope}`, ...parts].join('\n')).digest('hex');
}

/** Records a hit; true when the caller is over `max` per `seconds` for this key. */
export async function overLimit(key: string, max: number, seconds: number): Promise<boolean> {
  const { data, error } = await admin().rpc('anon_rate_hit', { p_key: key, p_max: max, p_seconds: seconds });
  if (error) throw new Error(error.message);
  return data === false;
}

/** Same, keyed by this client's daily IP tag. */
export function clientOverLimit(req: Request, scope: string, max: number, seconds: number): Promise<boolean> {
  return overLimit(rateKey(scope, ipTag(req)), max, seconds);
}
