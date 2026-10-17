/**
 * Key verification helpers: safety numbers, proof-of-key (spec §3.9) and
 * signed identity-key changes.
 *
 * Safety number (Signal-style): for each party
 *   f = SHA-512(lp("kithwall/v1/safety-number", userId, signPub)), then 5200 × f = SHA-512(f ‖ signPub)
 *   digits = six 5-digit groups, each u40be(f[5j..5j+5]) mod 100000
 * The two 30-digit strings are sorted and concatenated → 60 digits, order-independent.
 *
 * Signatures:
 *   proof-of-key: Ed25519(canonicalJson({ d:"kithwall/v1/proof-of-key", nonce }))
 *   key change:   Ed25519(oldSignPriv, canonicalJson({ d:"kithwall/v1/key-change", userId, newSignPub, newKxPub, at }))
 */
import { sha512 } from '@noble/hashes/sha2.js';
import { invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, concat, decodeFixed, lp, utf8 } from './encoding';
import { KEY_LEN, edSign, edVerifyB64 } from './primitives';

const SAFETY_ITERATIONS = 5200;

function fingerprintDigits(userId: string, signPub: Uint8Array): string {
  assertString(userId, 'userId');
  assertBytes(signPub, 'signPub', KEY_LEN);
  let f = sha512(lp('kithwall/v1/safety-number', userId, signPub));
  for (let i = 0; i < SAFETY_ITERATIONS; i++) f = sha512(concat(f, signPub));
  let out = '';
  for (let j = 0; j < 6; j++) {
    let v = 0;
    for (let b = 0; b < 5; b++) v = v * 256 + f[j * 5 + b]!;
    out += String(v % 100000).padStart(5, '0');
  }
  return out;
}

/** 60-digit safety number; identical for (a, b) and (b, a). */
export function safetyNumber(a: { userId: string; signPub: Uint8Array }, b: { userId: string; signPub: Uint8Array }): string {
  const fa = fingerprintDigits(a.userId, a.signPub);
  const fb = fingerprintDigits(b.userId, b.signPub);
  return fa < fb ? fa + fb : fb + fa;
}

function challengeMessage(nonce: string): Uint8Array {
  assertString(nonce, 'nonce', 1024);
  return utf8(canonicalJson({ d: 'kithwall/v1/proof-of-key', nonce }));
}

/** Signs a fresh server nonce with IK_sig (account deletion, recovery changes…). */
export function signChallenge(signPriv: Uint8Array, nonce: string): string {
  return b64u.encode(edSign(challengeMessage(nonce), signPriv));
}

export function verifyChallenge(signPub: Uint8Array, nonce: string, sig: string): boolean {
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 1024) return false;
  return edVerifyB64(sig, challengeMessage(nonce), signPub);
}

export interface KeyChange {
  userId: string;
  /** base64url Ed25519 public key (32 bytes). */
  newSignPub: string;
  /** base64url X25519 public key (32 bytes). */
  newKxPub: string;
  /** ISO-8601 timestamp. */
  at: string;
}

function keyChangeMessage(change: KeyChange): Uint8Array {
  if (typeof change !== 'object' || change === null) invalid('change must be an object');
  assertString(change.userId, 'userId');
  decodeFixed(change.newSignPub, 'newSignPub', KEY_LEN);
  decodeFixed(change.newKxPub, 'newKxPub', KEY_LEN);
  assertString(change.at, 'at', 64);
  return utf8(
    canonicalJson({ d: 'kithwall/v1/key-change', userId: change.userId, newSignPub: change.newSignPub, newKxPub: change.newKxPub, at: change.at }),
  );
}

/** The old identity key vouches for the new one. */
export function signKeyChange(oldSignPriv: Uint8Array, change: KeyChange): string {
  return b64u.encode(edSign(keyChangeMessage(change), oldSignPriv));
}

export function verifyKeyChange(oldSignPub: Uint8Array, change: KeyChange, sig: string): boolean {
  let msg: Uint8Array;
  try {
    msg = keyChangeMessage(change);
  } catch {
    return false;
  }
  return edVerifyB64(sig, msg, oldSignPub);
}
