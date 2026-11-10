import { describe, expect, it } from 'vitest';
import { b64u, deriveGameKey, diceCommit, diceOpens, diceRoll, diceSecret, diceSeed, gameLink, newGameNonce } from '../src/index';
import { expectCode } from './helpers';

const GAME = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const amk = Uint8Array.from({ length: 32 }, (_, i) => i);

describe('game chain link', () => {
  it('is canonical and covers every field', () => {
    const a = gameLink({ g: GAME, n: 1, p: 'x', a: { t: 'move', m: { c: 4 } } });
    expect(a).toHaveLength(43);
    expect(gameLink({ a: { m: { c: 4 }, t: 'move' }, p: 'x', n: 1, g: GAME })).toBe(a);
    expect(gameLink({ g: GAME, n: 1, p: 'x', a: { t: 'move', m: { c: 5 } } })).not.toBe(a);
    expect(gameLink({ g: GAME, n: 2, p: 'x', a: { t: 'move', m: { c: 4 } } })).not.toBe(a);
    expect(gameLink({ g: GAME, n: 1, p: 'y', a: { t: 'move', m: { c: 4 } } })).not.toBe(a);
  });
  it('refuses things that are not plain JSON objects', () => {
    expectCode(() => gameLink('x'), 'invalid_input');
    expectCode(() => gameLink([1]), 'invalid_input');
    expectCode(() => gameLink({ x: undefined }), 'invalid_input');
  });
  it('nonces are fresh', () => {
    expect(newGameNonce()).toHaveLength(22);
    expect(newGameNonce()).not.toBe(newGameNonce());
  });
});

describe('dice', () => {
  const key = deriveGameKey(amk);

  it('secrets are deterministic per account, game and message number', () => {
    expect(b64u.encode(key)).not.toBe(b64u.encode(amk));
    const s = diceSecret(key, GAME, 3);
    expect(s).toHaveLength(32);
    expect(b64u.encode(diceSecret(key, GAME, 3))).toBe(b64u.encode(s));
    expect(b64u.encode(diceSecret(key, GAME, 4))).not.toBe(b64u.encode(s));
    expect(b64u.encode(diceSecret(key, OTHER, 3))).not.toBe(b64u.encode(s));
    expect(b64u.encode(diceSecret(deriveGameKey(Uint8Array.from(amk, (x) => x ^ 1)), GAME, 3))).not.toBe(b64u.encode(s));
  });

  it('a commitment opens only with its own secret, in its own game', () => {
    const s = diceSecret(key, GAME, 0);
    const c = diceCommit(GAME, s);
    expect(c).toHaveLength(43);
    expect(diceOpens(GAME, b64u.encode(s), c)).toBe(true);
    expect(diceOpens(GAME, b64u.encode(diceSecret(key, GAME, 1)), c)).toBe(false);
    expect(diceOpens(OTHER, b64u.encode(s), c)).toBe(false);
    for (const bad of [null, 1, '', 'not base64!', b64u.encode(new Uint8Array(31))]) {
      expect(diceOpens(GAME, bad, c)).toBe(false);
      expect(diceOpens(GAME, b64u.encode(s), bad)).toBe(false);
    }
  });

  it('the seed depends on the secret, the game and the chain', () => {
    const s = diceSecret(key, GAME, 0);
    const seed = diceSeed(GAME, s, 'link-a');
    expect(diceSeed(GAME, s, 'link-a')).toBe(seed);
    expect(diceSeed(GAME, s, 'link-b')).not.toBe(seed);
    expect(diceSeed(GAME, diceSecret(key, GAME, 1), 'link-a')).not.toBe(seed);
    expect(diceSeed(OTHER, s, 'link-a')).not.toBe(seed);
  });

  it('matches a fixed vector (so every device, and any later rewrite, rolls the same)', () => {
    const s = diceSecret(key, GAME, 0);
    const seed = diceSeed(GAME, s, 'link');
    const rolls = Array.from({ length: 12 }, (_, k) => diceRoll(seed, k));
    expect(rolls.every((r) => r >= 1 && r <= 6)).toBe(true);
    expect({ commit: diceCommit(GAME, s), seed, rolls }).toMatchInlineSnapshot(`
      {
        "commit": "I1sFRy_8jHZYudu4zcl711d79RbVs0_xJE6gb5xhx6k",
        "rolls": [
          2,
          3,
          2,
          1,
          3,
          2,
          3,
          1,
          3,
          6,
          2,
          5,
        ],
        "seed": "ThA_epzDhYHy4Jv_DTpfth_Q4Svu5Pt1x5mdHzVJSes",
      }
    `);
  });

  it('rolls are uniform', () => {
    const counts = [0, 0, 0, 0, 0, 0];
    const N = 30_000;
    for (let i = 0; i < N / 10; i++) {
      const seed = diceSeed(GAME, diceSecret(key, GAME, i), 'x');
      for (let k = 0; k < 10; k++) counts[diceRoll(seed, k) - 1]!++;
    }
    // Chi-square with 5 degrees of freedom: 20.5 is the 0.1 % point.
    const chi = counts.reduce((a, c) => a + (c - N / 6) ** 2 / (N / 6), 0);
    expect(chi).toBeLessThan(20.5);
    // Other dice work too, without modulo bias.
    const d3 = [0, 0, 0];
    const seed3 = diceSeed(GAME, diceSecret(key, GAME, 1), 'y');
    for (let k = 0; k < 3000; k++) d3[diceRoll(seed3, k, 3) - 1]!++;
    expect(Math.min(...d3)).toBeGreaterThan(850);
  });

  it('refuses malformed input', () => {
    const seed = diceSeed(GAME, diceSecret(key, GAME, 0), 'l');
    expectCode(() => diceRoll('AAAA', 0), 'invalid_input');
    expectCode(() => diceRoll(seed, -1), 'invalid_input');
    expectCode(() => diceRoll(seed, 0, 1), 'invalid_input');
    expectCode(() => diceSecret(key, GAME, -1), 'invalid_input');
    expectCode(() => diceCommit(GAME, new Uint8Array(5)), 'invalid_input');
  });
});
