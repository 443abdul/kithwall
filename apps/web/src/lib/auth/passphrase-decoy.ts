// Decoy ids for the passphrase lookup (app/api/auth/passkey/passphrase/lookup, security review W3).
import { createHmac } from 'node:crypto';

/** The server secret for decoys, or null when none is configured (the route then fails closed). */
export function decoySecret(): string | null {
  const key = process.env.ALTCHA_HMAC_KEY || process.env.SUPABASE_SECRET_KEY || '';
  return key.length >= 16 ? key : null;
}

/** A version-4 UUID derived from the handle: the same shape as a real user id, stable per handle. */
export function decoyId(handle: string, secret: string): string {
  const b = createHmac('sha256', secret).update(`kithwall/passphrase-decoy/v2\n${handle}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;   // version 4
  b[8] = (b[8]! & 0x3f) | 0x80;   // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}