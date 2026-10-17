import { describe, expect, it } from 'vitest';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  b64u,
  combineRecoveryShares,
  generateEphemeral,
  generateIdentity,
  newSymmetricKey,
  openSealed,
  rotateRecovery,
  seal,
  splitRecoveryKey,
  verificationPhrase,
} from '../src/index';
import { lp } from '../src/encoding';
import { expectCodeAsync, expectCode } from './helpers';

function subsets<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [...subsets(rest, k - 1).map((s) => [first!, ...s]), ...subsets(rest, k)];
}

describe('Shamir split / combine', () => {
  const { rk, rkCommitment } = rotateRecovery('owner', newSymmetricKey());

  it('every k-of-n subset recovers RK for n = 3..5; every (k-1) subset fails the commitment', async () => {
    for (let n = 3; n <= 5; n++) {
      for (let k = 2; k <= n; k++) {
        const shares = await splitRecoveryKey(rk, n, k);
        expect(shares).toHaveLength(n);
        for (const s of shares) expect(s.length).toBe(33);
        for (let size = k; size <= n; size++) {
          for (const sub of subsets(shares, size)) expect(await combineRecoveryShares(sub, rkCommitment)).toEqual(rk);
        }
        if (k - 1 >= 2) {
          for (const sub of subsets(shares, k - 1)) await expectCodeAsync(() => combineRecoveryShares(sub, rkCommitment), 'bad_share');
        }
      }
    }
  });

  it('2-of-2 recovers', async () => {
    const shares = await splitRecoveryKey(rk, 2, 2);
    expect(await combineRecoveryShares(shares, rkCommitment)).toEqual(rk);
  });

  it('a corrupted share fails (data byte or x-coordinate)', async () => {
    const shares = await splitRecoveryKey(rk, 3, 2);
    for (const i of [0, 15, 31]) {
      const bad = new Uint8Array(shares[0]!);
      bad[i] = bad[i]! ^ 1;
      await expectCodeAsync(() => combineRecoveryShares([bad, shares[1]!], rkCommitment), 'bad_share');
    }
    const badX = new Uint8Array(shares[0]!);
    badX[32] = badX[32] === 255 ? 254 : badX[32]! + 1;
    if (badX[32] !== shares[1]![32]) await expectCodeAsync(() => combineRecoveryShares([badX, shares[1]!], rkCommitment), 'bad_share');
  });

  it('rejects duplicates, zero x, wrong lengths, wrong commitment', async () => {
    const shares = await splitRecoveryKey(rk, 3, 2);
    await expectCodeAsync(() => combineRecoveryShares([shares[0]!, shares[0]!], rkCommitment), 'bad_share');
    const zeroX = new Uint8Array(shares[0]!);
    zeroX[32] = 0;
    await expectCodeAsync(() => combineRecoveryShares([zeroX, shares[1]!], rkCommitment), 'bad_share');
    await expectCodeAsync(() => combineRecoveryShares([shares[0]!.subarray(0, 32), shares[1]!], rkCommitment), 'bad_share');
    await expectCodeAsync(() => combineRecoveryShares(['x' as unknown as Uint8Array, shares[1]!], rkCommitment), 'bad_share');
    await expectCodeAsync(() => combineRecoveryShares(shares.slice(0, 2), rotateRecovery('owner', newSymmetricKey()).rkCommitment), 'bad_share');
    await expectCodeAsync(() => combineRecoveryShares(shares.slice(0, 2), 'not-a-commitment'), 'bad_share');
    await expectCodeAsync(() => combineRecoveryShares([shares[0]!], rkCommitment), 'invalid_input');
    await expectCodeAsync(() => combineRecoveryShares(Array(6).fill(shares[0]!), rkCommitment), 'invalid_input');
    await expectCodeAsync(() => combineRecoveryShares('x' as unknown as Uint8Array[], rkCommitment), 'invalid_input');
  });

  it('validates n and k', async () => {
    for (const [n, k] of [[3, 1], [2, 3], [6, 2], [5, 6], [3.5, 2], [3, NaN]] as const) {
      await expectCodeAsync(() => splitRecoveryKey(rk, n, k), 'invalid_input');
    }
    await expectCodeAsync(() => splitRecoveryKey(new Uint8Array(16), 3, 2), 'invalid_input');
  });

  it('full trustee flow: shares sealed to trustees, re-sealed to the ephemeral key, combined', async () => {
    const owner = generateIdentity();
    const trustees = [generateIdentity(), generateIdentity(), generateIdentity()];
    const shares = await splitRecoveryKey(rk, 3, 2);
    const stored = trustees.map((t, i) =>
      seal({ recipientKxPub: t.kxPub, senderSignPriv: owner.signPriv, context: `recovery-share/owner/t${i}`, plaintext: shares[i]! }),
    );
    const E = generateEphemeral();
    const requestId = 'req-42';
    const released = [0, 2].map((i) => {
      const t = trustees[i]!;
      const share = openSealed({ sealed: stored[i]!, recipientKxPriv: t.kxPriv, recipientKxPub: t.kxPub, senderSignPub: owner.signPub, context: `recovery-share/owner/t${i}` });
      return { from: t, box: seal({ recipientKxPub: E.pub, senderSignPriv: t.signPriv, context: `recovery-release/${requestId}/t${i}`, plaintext: share }), i };
    });
    const got = released.map(({ from, box, i }) =>
      openSealed({ sealed: box, recipientKxPriv: E.priv, recipientKxPub: E.pub, senderSignPub: from.signPub, context: `recovery-release/${requestId}/t${i}` }),
    );
    expect(await combineRecoveryShares(got, rkCommitment)).toEqual(rk);
  });
});

describe('ephemeral keys and verification phrase', () => {
  it('generateEphemeral returns X25519 pairs', () => {
    const e = generateEphemeral();
    expect(e.pub.length).toBe(32);
    expect(e.priv.length).toBe(32);
  });

  it('is 6 BIP-39 words from the first 66 bits of the domain-separated hash', () => {
    const pub = generateEphemeral().pub;
    const words = verificationPhrase('req-1', pub);
    expect(words).toHaveLength(6);
    for (const w of words) expect(wordlist).toContain(w);
    expect(verificationPhrase('req-1', pub)).toEqual(words);
    expect(verificationPhrase('req-2', pub)).not.toEqual(words);
    // Independent bit extraction
    const h = sha256(lp('kithwall/v1/verification-phrase', 'req-1', pub));
    const bits = Array.from(h, (b) => b.toString(2).padStart(8, '0')).join('');
    const expected = Array.from({ length: 6 }, (_, i) => wordlist[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
    expect(words).toEqual(expected);
  });

  it('validates inputs', () => {
    expectCode(() => verificationPhrase('', generateEphemeral().pub), 'invalid_input');
    expectCode(() => verificationPhrase('r', new Uint8Array(31)), 'invalid_input');
  });

  it('commitment is the spec-described b64u(SHA-256(domain ‖ RK))', () => {
    const r = rotateRecovery('u', newSymmetricKey());
    const expected = sha256(new Uint8Array([...new TextEncoder().encode('kithwall/v1/rk-commitment'), ...r.rk]));
    expect(r.rkCommitment).toBe(b64u.encode(expected));
  });
});
