// Key transparency, device side (core.ts, witness.ts, net/csp.ts witnessConnectSource). The log is built
// in memory with the same leaf format as the server, so these are the exact checks a device makes on what
// /api/kt returns. Run: npx vitest run src/lib/kt/core.test.ts
import { describe, expect, it } from 'vitest';
import {
  b64u, consistencyProof, inclusionProof, ktLeafHash, merkleLeafHash, merkleRoot, type KtEntry,
} from '@kithwall/crypto';
import {
  cleanKeyLog, compareHeads, headsConsistent, logRefuses, markFor, nextMark, parseAlarm, parseHead, parseInclusionResult,
  validKeys, verifyOpening, type KtHead,
} from './core';
import { witnessFor } from './witness';
import { witnessConnectSource } from '../net/csp';

const ALICE = '0f9c3f1e-6a4b-4c2d-9e8f-1a2b3c4d5e6f';
const key = (n: number) => b64u.encode(new Uint8Array(32).fill(n));
const entry = (version: number, n: number, salt = 7): KtEntry => ({
  userId: ALICE, signPub: key(n), kxPub: key(n + 1), version, salt: new Uint8Array(32).fill(salt),
});

// A log of 13 entries: noise, Alice's sign-up (index 3), more noise, Alice's rotation (index 9), noise.
const leaves = Array.from({ length: 13 }, (_, i) => merkleLeafHash(new Uint8Array([0xee, i])));
leaves[3] = ktLeafHash(entry(1, 10));
leaves[9] = ktLeafHash(entry(2, 20, 9));
const headAt = (n: number): KtHead => ({ size: n, root: b64u.encode(merkleRoot(leaves.slice(0, n))), at: '2026-11-02T00:00:00Z' });
const enc = (p: Uint8Array[]) => p.map((h) => b64u.encode(h));

describe('tree heads', () => {
  it('parses heads and rejects malformed ones', () => {
    expect(parseHead(headAt(5))).toEqual(headAt(5));
    expect(parseHead({ size: 0, root: headAt(5).root })).toEqual({ size: 0, root: headAt(5).root, at: null });
    expect(parseHead({ size: -1, root: headAt(5).root })).toBeNull();
    expect(parseHead({ size: 1.5, root: headAt(5).root })).toBeNull();
    expect(parseHead({ size: 3, root: 'nope' })).toBeNull();
    expect(parseHead({ size: 3, root: b64u.encode(new Uint8Array(31)) + 'AA' })).toBeNull();
    expect(parseHead(null)).toBeNull();
  });

  it('classifies a fresh head against the stored one', () => {
    expect(compareHeads(null, headAt(4))).toBe('first');
    expect(compareHeads(headAt(4), headAt(4))).toBe('same');
    expect(compareHeads(headAt(4), { ...headAt(4), root: headAt(5).root })).toBe('forked');
    expect(compareHeads(headAt(4), headAt(9))).toBe('grow');
    expect(compareHeads(headAt(9), headAt(4))).toBe('older');
  });

  it('accepts growth only with a valid consistency proof', () => {
    for (const [a, b] of [[1, 13], [4, 9], [8, 13], [12, 13], [7, 7]] as const) {
      const proof = enc(consistencyProof(leaves.slice(0, b), a));
      expect(headsConsistent(headAt(a), headAt(b), proof), `${a} → ${b}`).toBe(true);
    }
    const proof = enc(consistencyProof(leaves.slice(0, 9), 4));
    expect(headsConsistent(headAt(4), { ...headAt(9), root: headAt(8).root }, proof)).toBe(false);
    expect(headsConsistent(headAt(4), headAt(9), proof.slice(1))).toBe(false);
    expect(headsConsistent(headAt(4), headAt(9), [...proof.slice(0, -1), 'x'])).toBe(false);
    expect(headsConsistent(headAt(4), headAt(9), 'not an array')).toBe(false);
  });

  it('a rewritten history (one old entry replaced) is caught', () => {
    const forged = leaves.slice();
    forged[3] = ktLeafHash(entry(1, 99));   // the server swaps Alice's sign-up key
    const forgedHead: KtHead = { size: 13, root: b64u.encode(merkleRoot(forged)), at: null };
    expect(headsConsistent(headAt(8), forgedHead, enc(consistencyProof(forged, 8)))).toBe(false);
    expect(headsConsistent(headAt(8), forgedHead, enc(consistencyProof(leaves, 8)))).toBe(false);
  });

  it('alarm records round-trip and junk is dropped', () => {
    const a = { kind: 'forked', seen: headAt(8), got: headAt(13), at: '2026-11-02T00:00:00Z', via: 'witness' };
    expect(parseAlarm(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseAlarm({ ...a, kind: 'other' })).toBeNull();
    expect(parseAlarm({ ...a, seen: {} })).toBeNull();
  });
});

describe('openings (inclusion of a contact\'s current key)', () => {
  const keys = { userId: ALICE, signPub: key(20), kxPub: key(21) };
  const proof = (i: number, n: number) => enc(inclusionProof(leaves.slice(0, n), i));

  it('verifies the current key at its leaf', () => {
    expect(verifyOpening(headAt(13), keys, { index: 9, version: 2, salt: b64u.encode(new Uint8Array(32).fill(9)), proof: proof(9, 13) })).toBe(true);
    expect(verifyOpening(headAt(10), keys, { index: 9, version: 2, salt: b64u.encode(new Uint8Array(32).fill(9)), proof: proof(9, 10) })).toBe(true);
  });

  it('fails for other keys, versions, salts, users, positions or heads', () => {
    const ok = { index: 9, version: 2, salt: b64u.encode(new Uint8Array(32).fill(9)), proof: proof(9, 13) };
    expect(verifyOpening(headAt(13), { ...keys, signPub: key(30) }, ok)).toBe(false);          // the server's own key
    expect(verifyOpening(headAt(13), { ...keys, kxPub: key(30) }, ok)).toBe(false);
    expect(verifyOpening(headAt(13), { ...keys, userId: '00000000-0000-4000-8000-000000000000' }, ok)).toBe(false);
    expect(verifyOpening(headAt(13), keys, { ...ok, version: 1 })).toBe(false);
    expect(verifyOpening(headAt(13), keys, { ...ok, salt: b64u.encode(new Uint8Array(32)) })).toBe(false);
    expect(verifyOpening(headAt(13), keys, { ...ok, index: 3 })).toBe(false);
    expect(verifyOpening(headAt(12), keys, ok)).toBe(false);
    expect(verifyOpening(headAt(13), keys, { ...ok, proof: ok.proof.slice(1) })).toBe(false);
    expect(verifyOpening(headAt(13), keys, { ...ok, salt: 'short' })).toBe(false);
    // The previous key is in the log too, but at its own leaf with its own version.
    expect(verifyOpening(headAt(13), { userId: ALICE, signPub: key(10), kxPub: key(11) },
      { index: 3, version: 1, salt: b64u.encode(new Uint8Array(32).fill(7)), proof: proof(3, 13) })).toBe(true);
  });

  it('parses reply entries strictly', () => {
    expect(parseInclusionResult({ user: ALICE, status: 'ok', index: 1, version: 1, salt: 'x', proof: [] })?.status).toBe('ok');
    expect(parseInclusionResult({ user: ALICE, status: 'missing' })).toEqual({ user: ALICE, status: 'missing' });
    expect(parseInclusionResult({ user: ALICE, status: 'later', index: 4 })).toEqual({ user: ALICE, status: 'later', index: 4 });
    expect(parseInclusionResult({ user: ALICE, status: 'ok', index: 1 })).toBeNull();
    expect(parseInclusionResult({ user: 'ALICE', status: 'missing' })).toBeNull();
    expect(parseInclusionResult({ user: ALICE, status: 'maybe' })).toBeNull();
    expect(validKeys({ userId: ALICE, signPub: key(1), kxPub: key(2) })).toBe(true);
    expect(validKeys({ userId: ALICE, signPub: 'x', kxPub: key(2) })).toBe(false);
  });
});

describe('what the account remembers, and when sharing pauses', () => {
  it('keeps only well-formed marks', () => {
    const m = cleanKeyLog({
      [ALICE]: { s: key(1), x: key(2), r: 'ok', i: 4, n: 9, at: 'now' },
      'not-a-uuid': { s: key(1), x: key(2), r: 'ok', at: 'now' },
      '00000000-0000-4000-8000-000000000000': { s: key(1), x: key(2), r: 'perhaps', at: 'now' },
    });
    expect(Object.keys(m)).toEqual([ALICE]);
    expect(markFor(m, ALICE, key(1), key(2))).toBe('ok');
    expect(markFor(m, ALICE, key(3), key(2))).toBeNull();   // a new key is unchecked
    expect(markFor(null, ALICE, key(1), key(2))).toBeNull();
  });

  it('refuses keys the log did not vouch for, and unconfirmed keys while the log looks forked', () => {
    expect(logRefuses('missing', false)).toBe(true);
    expect(logRefuses('bad', false)).toBe(true);
    expect(logRefuses('ok', false)).toBe(false);
    expect(logRefuses('accepted', false)).toBe(false);
    expect(logRefuses(null, false)).toBe(false);
    expect(logRefuses(null, true)).toBe(true);
    expect(logRefuses('ok', true)).toBe(false);
    expect(logRefuses('accepted', true)).toBe(false);
  });

  it('a later failure never overrides the user\'s acceptance; soft results are not remembered', () => {
    expect(nextMark(null, 'ok')).toBe('ok');
    expect(nextMark('accepted', 'ok')).toBe('ok');
    expect(nextMark('accepted', 'missing')).toBe('accepted');
    expect(nextMark('ok', 'bad')).toBe('bad');
    expect(nextMark(null, 'unavailable')).toBeNull();
    expect(nextMark(null, 'hidden')).toBeNull();
    expect(nextMark('ok', 'alarm')).toBeNull();
  });
});

describe('the public witness', () => {
  it('derives the branch and raw head URLs for GitHub repositories only', () => {
    expect(witnessFor('https://github.com/443abdul/kithwall')).toEqual({
      branchUrl: 'https://github.com/443abdul/kithwall/tree/kt-heads',
      headUrl: 'https://raw.githubusercontent.com/443abdul/kithwall/kt-heads/head.json',
    });
    expect(witnessFor('https://gitlab.com/someone/kithwall')).toBeNull();
    expect(witnessFor('http://github.com/a/b')).toBeNull();
    expect(witnessFor('https://github.com/a/b/c')).toBeNull();
    expect(witnessFor(null)).toBeNull();
  });

  it('adds exactly the witness origin to connect-src', () => {
    expect(witnessConnectSource('https://raw.githubusercontent.com/443abdul/kithwall/kt-heads/head.json')).toBe('https://raw.githubusercontent.com');
    expect(witnessConnectSource('http://raw.githubusercontent.com/x')).toBeNull();
    expect(witnessConnectSource(null)).toBeNull();
    expect(witnessConnectSource('javascript:alert(1)')).toBeNull();
  });
});
