/**
 * Games inside chats (docs/v2/11-games.md): the hash chain that links a game's messages, and fair dice.
 *
 * Every game message names the hash of the game message before it (`gameLink`), so a game is one chain that
 * every device can check from the messages alone.
 *
 * Dice are commit-reveal threaded through the turn messages. A player commits to a secret in one of their
 * own messages; later messages from the other players add values that player could not know when committing;
 * the player's next turn message reveals the secret, and the rolls of that turn are a hash of the secret and
 * of the chain up to that point:
 *
 *   secret  = HMAC-SHA-256(gameKey, "kithwall/v1/dice-secret\n" ‖ lp(game, u64(seq)))      32 bytes
 *   commit  = SHA-256("kithwall/v1/dice-commit\n" ‖ lp(game, secret))
 *   seed    = SHA-256("kithwall/v1/dice-seed\n" ‖ lp(game, secret, link))                  link = chain so far
 *   roll k  = uniform in 1..sides from SHA-256("kithwall/v1/dice-roll\n" ‖ lp(seed, u64(k), u64(block)))
 *
 * The secret is derived from the account's master key instead of being stored, so every device of the same
 * person can open a commitment another of their devices made, and nothing secret has to be kept between
 * turns. HMAC-SHA-256 under a secret key is a PRF: to everyone else the secret is 32 unpredictable bytes,
 * and the commitment (a hash of it) reveals nothing useful and binds the player to it.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, concat, ctEqual, lp, randomBytes, u64be, utf8 } from './encoding';
import { hkdfSha256, KEY_LEN, sha256 } from './primitives';

const LINK_DOMAIN = 'kithwall/v1/game-link\n';
const SECRET_DOMAIN = 'kithwall/v1/dice-secret\n';
const COMMIT_DOMAIN = 'kithwall/v1/dice-commit\n';
const SEED_DOMAIN = 'kithwall/v1/dice-seed\n';
const ROLL_DOMAIN = 'kithwall/v1/dice-roll\n';

/** The hash that the next game message must name: SHA-256 over the canonical JSON of this one, base64url. */
export function gameLink(event: unknown): string {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) invalid('game event must be an object');
  return b64u.encode(sha256(concat(utf8(LINK_DOMAIN), utf8(canonicalJson(event)))));
}

/** A fresh public nonce carried by every game message (16 random bytes, base64url). */
export function newGameNonce(): string {
  return b64u.encode(randomBytes(16));
}

/** The key this account derives its dice secrets from (never leaves the device). */
export function deriveGameKey(amk: Uint8Array): Uint8Array {
  assertBytes(amk, 'amk', KEY_LEN);
  return hkdfSha256(amk, 'kithwall/v1/games');
}

/** The secret behind the commitment made in game message number `seq` of `game`. */
export function diceSecret(gameKey: Uint8Array, game: string, seq: number): Uint8Array {
  assertBytes(gameKey, 'game key', KEY_LEN);
  assertString(game, 'game');
  return hmac(nobleSha256, gameKey, concat(utf8(SECRET_DOMAIN), lp(game, u64be(seq))));
}

/** commit = SHA-256("kithwall/v1/dice-commit\n" ‖ lp(game, secret)), base64url. */
export function diceCommit(game: string, secret: Uint8Array): string {
  assertString(game, 'game');
  assertBytes(secret, 'dice secret', KEY_LEN);
  return b64u.encode(sha256(concat(utf8(COMMIT_DOMAIN), lp(game, secret))));
}

/** True when `secret` (base64url) opens `commit`. Never throws: anything malformed is simply false. */
export function diceOpens(game: unknown, secret: unknown, commit: unknown): boolean {
  if (typeof game !== 'string' || !game || typeof secret !== 'string' || typeof commit !== 'string') return false;
  let s: Uint8Array, want: Uint8Array;
  try { s = b64u.decode(secret); want = b64u.decode(commit); } catch { return false; }
  if (s.length !== KEY_LEN || want.length !== 32) return false;
  return ctEqual(sha256(concat(utf8(COMMIT_DOMAIN), lp(game, s))), want);
}

/**
 * The seed of one turn's rolls: the revealed secret mixed with `link`, the hash of the game's chain up to the
 * message before the reveal (which covers every nonce and every earlier reveal). Base64url.
 */
export function diceSeed(game: string, secret: Uint8Array, link: string): string {
  assertString(game, 'game');
  assertBytes(secret, 'dice secret', KEY_LEN);
  assertString(link, 'link');
  return b64u.encode(sha256(concat(utf8(SEED_DOMAIN), lp(game, secret, link))));
}

/**
 * Roll number `k` (0, 1, 2…) of the turn with this seed: a uniform integer in 1..sides. Bytes that would
 * bias the result are skipped (rejection sampling), so every face is exactly equally likely.
 */
export function diceRoll(seed: string, k: number, sides = 6): number {
  const s = b64u.decode(seed);
  if (s.length !== 32) invalid('dice seed must be 32 bytes');
  if (!Number.isSafeInteger(k) || k < 0) invalid('roll index must be a non-negative integer');
  if (!Number.isSafeInteger(sides) || sides < 2 || sides > 256) invalid('sides must be in 2..256');
  const limit = 256 - (256 % sides);
  for (let block = 0; block < 64; block++) {
    const bytes = sha256(concat(utf8(ROLL_DOMAIN), lp(s, u64be(k), u64be(block))));
    for (const b of bytes) if (b < limit) return 1 + (b % sides);
  }
  // 2048 bytes all rejected: probability below 2^-10000 for any number of sides.
  return invalid('dice roll failed');
}
