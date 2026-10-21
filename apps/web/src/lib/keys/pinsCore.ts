// Identity-key pinning (security review K2). Pure: unit-tested in Node (pins.test.ts).
//
// The first time this device sees a contact's identity keys it pins them (trust on first use) in the
// user's encrypted vault. Afterwards any difference between the published keys and the pinned ones is a
// "safety number changed" event, shown in 1:1 chats and on the profile until the user acknowledges it.
//
// While a change is unacknowledged, new keys are NOT sealed to the new identity when either
//   * the contact was verified (safety number compared) — always ask first, or
//   * the change is not vouched for: no chain of key changes signed by the pinned key leads to it.
// A vouched change of an unverified contact (they rotated their key with their old device) is shown
// but does not stop sharing, like Signal.
import { b64u, verifyKeyChange, type KeyChange } from '@kithwall/crypto';

export interface Pin {
  /** Pinned identity signing key (base64url). */
  s: string;
  /** Pinned key-exchange key (base64url). */
  x: string;
  /** When it was pinned / last acknowledged (ISO). */
  at: string;
}
export type PinMap = Record<string, Pin>;

export interface KeyChangeLogRow { change: KeyChange; sig: string; created_at: string }

export type PinStatus = 'new' | 'same' | 'changed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export function cleanPins(v: unknown): PinMap {
  const out: PinMap = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
    const p = e as Partial<Pin> | null;
    if (UUID.test(id) && p && typeof p.s === 'string' && KEY.test(p.s) && typeof p.x === 'string' && KEY.test(p.x) && typeof p.at === 'string') {
      out[id] = { s: p.s, x: p.x, at: p.at };
    }
  }
  return out;
}

export function pinStatus(pin: Pin | undefined, signPub: string, kxPub: string): PinStatus {
  if (!pin) return 'new';
  return pin.s === signPub && pin.x === kxPub ? 'same' : 'changed';
}

/**
 * True when signed key changes lead from the pinned keys to the current ones: each row counts only if
 * the key reached so far signed it, and the chain must end at BOTH current public keys.
 */
export function vouchedFrom(pin: Pin, signPub: string, kxPub: string, rows: KeyChangeLogRow[]): boolean {
  let s = pin.s;
  let x = pin.x;
  for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    try {
      if (verifyKeyChange(b64u.decode(s), r.change, r.sig)) { s = r.change.newSignPub; x = r.change.newKxPub; }
    } catch { /* malformed row: ignore */ }
  }
  return s === signPub && x === kxPub;
}

/**
 * May this device seal new keys to the person's CURRENT identity without asking?
 * `verifiedKey` is the signing key the user verified (safety number), if any.
 */
export function maySealTo(args: { pin: Pin | undefined; signPub: string; kxPub: string; verifiedKey: string | null; vouched: boolean }): boolean {
  const st = pinStatus(args.pin, args.signPub, args.kxPub);
  if (st !== 'changed') {
    // A verified contact whose verified key differs from the published one: ask first.
    return !(args.verifiedKey && args.verifiedKey !== args.signPub);
  }
  // Re-verifying the new safety number re-pins it, so a verified contact never passes here unasked.
  if (args.verifiedKey) return false;
  return args.vouched;
}

/**
 * How much this device trusts the identity keys it uses for a contact (security review R-K-1).
 *   self       my own keys (from my unlocked identity, never the server's copy)
 *   new        first sight: pinned now (trust on first use)
 *   pinned     the published keys are the pinned ones
 *   vouched    the published keys differ, but a chain of key changes signed by the pinned key leads to them
 *   unvouched  the published keys differ and nothing signed by the pinned key vouches for them: this device
 *              keeps using the PINNED keys, so anything signed by the new key fails verification until the
 *              user accepts the change (KeyChangeBanner / VerifyScreen)
 */
export type SignerTrust = 'self' | 'new' | 'pinned' | 'vouched' | 'unvouched';
export interface TrustedKeys { s: string; x: string; trust: SignerTrust }

/** The identity keys to verify (and seal) with for a contact, given the pin and the published keys. */
export function trustedKeysFor(pin: Pin | undefined, published: { s: string; x: string }, log: KeyChangeLogRow[] | null): TrustedKeys {
  const st = pinStatus(pin, published.s, published.x);
  if (st === 'new') return { s: published.s, x: published.x, trust: 'new' };
  if (st === 'same') return { s: published.s, x: published.x, trust: 'pinned' };
  if (log && vouchedFrom(pin!, published.s, published.x, log)) return { s: published.s, x: published.x, trust: 'vouched' };
  return { s: pin!.s, x: pin!.x, trust: 'unvouched' };
}
