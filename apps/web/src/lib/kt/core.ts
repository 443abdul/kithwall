// Key transparency, the pure part (docs/v2/09-key-transparency.md). No React, no fetch, no storage: the
// shapes the /api/kt routes return, and the checks a device makes on them. Unit-tested in Node (core.test.ts).
//
// A device keeps the last tree head it verified (lib/kt/client.ts, per device). Every head it fetches later
// must extend that one: same size and same root, or a larger size with a consistency proof from the stored
// head, or a smaller (stale, cached) size that is provably a prefix of it. Anything else means the log was
// rewritten (forked) or shrank, and the device stops trusting new keys until the user looks at it.
// A contact's key counts as logged when the opening (salt, key version, leaf index) and the audit path
// lead from exactly the keys this device is about to use to the root of a head it verified.
import { b64u, ktLeafHash, MERKLE_HASH_LEN, verifyConsistency, verifyInclusion } from '@kithwall/crypto';

/** A tree head: number of entries, root hash (base64url) and when the server appended the last entry. */
export interface KtHead { size: number; root: string; at: string | null }

export interface KtConsistencyReply { from: KtHead; to: KtHead; proof: string[] }

export type KtInclusionResult =
  | { user: string; status: 'ok'; index: number; version: number; salt: string; proof: string[] }
  | { user: string; status: 'missing' | 'hidden' | 'later'; index?: number };

export interface KtInclusionReply { head: KtHead; results: KtInclusionResult[] }

/** What a device learned about one person's current keys. */
export type KtVerdict = 'ok' | 'missing' | 'bad' | 'hidden' | 'unavailable' | 'alarm';

/** Evidence that the server showed this device two incompatible histories. */
export interface KtAlarm { kind: 'forked' | 'shrunk'; seen: KtHead; got: KtHead; at: string; via?: 'witness' }

const HASH = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
export const KT_MAX_BATCH = 50;

function hash(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !HASH.test(s)) return null;
  try {
    const b = b64u.decode(s);
    return b.length === MERKLE_HASH_LEN ? b : null;
  } catch { return null; }
}

export function decodeProof(p: unknown): Uint8Array[] | null {
  if (!Array.isArray(p) || p.length > 64) return null;
  const out: Uint8Array[] = [];
  for (const x of p) { const h = hash(x); if (!h) return null; out.push(h); }
  return out;
}

export function parseHead(v: unknown): KtHead | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.size !== 'number' || !Number.isSafeInteger(o.size) || o.size < 0 || !hash(o.root)) return null;
  const at = typeof o.at === 'string' && o.at.length <= 64 ? o.at : null;
  return { size: o.size, root: o.root as string, at };
}

export function parseAlarm(v: unknown): KtAlarm | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const seen = parseHead(o.seen);
  const got = parseHead(o.got);
  if ((o.kind !== 'forked' && o.kind !== 'shrunk') || !seen || !got || typeof o.at !== 'string') return null;
  return { kind: o.kind, seen, got, at: o.at, ...(o.via === 'witness' ? { via: 'witness' as const } : {}) };
}

export const sameHead = (a: KtHead, b: KtHead) => a.size === b.size && a.root === b.root;

/**
 * How a freshly fetched head relates to the stored one:
 *   first   nothing stored yet (trust on first use of the log)
 *   same    identical
 *   forked  same size, different root: two histories, no proof needed
 *   grow    larger: verify a consistency proof stored → fresh before storing it
 *   older   smaller (e.g. a cached response): verify fresh → stored, keep the stored head
 */
export type HeadStep = 'first' | 'same' | 'forked' | 'grow' | 'older';

export function compareHeads(stored: KtHead | null, fresh: KtHead): HeadStep {
  if (!stored) return 'first';
  if (fresh.size === stored.size) return fresh.root === stored.root ? 'same' : 'forked';
  return fresh.size > stored.size ? 'grow' : 'older';
}

/** Does `proof` show that `older` is a prefix of `newer`? Uses only the two heads' own roots. */
export function headsConsistent(older: KtHead, newer: KtHead, proof: unknown): boolean {
  const p = decodeProof(proof);
  const r1 = hash(older.root);
  const r2 = hash(newer.root);
  if (!p || !r1 || !r2) return false;
  return verifyConsistency(older.size, newer.size, p, r1, r2);
}

export interface PublishedKeys { userId: string; signPub: string; kxPub: string }

/**
 * Is this person's key pair in the log under `head`? The leaf is recomputed from the keys THIS device holds
 * and the salt the server handed out, so the server can't vouch for keys other than the ones checked.
 */
export function verifyOpening(head: KtHead, keys: PublishedKeys, r: { index: number; version: number; salt: string; proof: unknown }): boolean {
  const root = hash(head.root);
  const salt = hash(r.salt);
  const proof = decodeProof(r.proof);
  if (!root || !salt || !proof || !Number.isSafeInteger(r.index) || !Number.isSafeInteger(r.version)) return false;
  let leaf: Uint8Array;
  try {
    leaf = ktLeafHash({ userId: keys.userId, signPub: keys.signPub, kxPub: keys.kxPub, version: r.version, salt });
  } catch { return false; }
  return verifyInclusion(leaf, r.index, head.size, proof, root);
}

/** One reply entry, validated (anything malformed becomes null and counts as a bad answer). */
export function parseInclusionResult(v: unknown): KtInclusionResult | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.user !== 'string' || !UUID.test(o.user)) return null;
  if (o.status === 'ok') {
    if (typeof o.index !== 'number' || typeof o.version !== 'number' || typeof o.salt !== 'string' || !Array.isArray(o.proof)) return null;
    return { user: o.user, status: 'ok', index: o.index, version: o.version, salt: o.salt, proof: o.proof as string[] };
  }
  if (o.status === 'missing' || o.status === 'hidden' || o.status === 'later') {
    return { user: o.user, status: o.status, ...(typeof o.index === 'number' ? { index: o.index } : {}) };
  }
  return null;
}

/** Keys well-formed enough to ask about. */
export function validKeys(k: PublishedKeys): boolean {
  return UUID.test(k.userId) && KEY.test(k.signPub) && KEY.test(k.kxPub);
}

// ---------------------------------------------------------------------------------------------
// What this device remembers per person (in the encrypted vault, namespace "keylog").

export type KeyLogMark = 'ok' | 'missing' | 'bad' | 'accepted';

export interface KeyLogEntry {
  /** The keys this mark is about (base64url). */
  s: string;
  x: string;
  /** ok: logged; missing / bad: not provably logged; accepted: the user chose to use them anyway. */
  r: KeyLogMark;
  /** Leaf index and tree size of the last successful check. */
  i?: number;
  n?: number;
  at: string;
}
export type KeyLogMap = Record<string, KeyLogEntry>;

export function cleanKeyLog(v: unknown): KeyLogMap {
  const out: KeyLogMap = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, e] of Object.entries(v as Record<string, unknown>)) {
    const x = e as Partial<KeyLogEntry> | null;
    if (!UUID.test(id) || !x || typeof x.s !== 'string' || !KEY.test(x.s) || typeof x.x !== 'string' || !KEY.test(x.x)) continue;
    if (x.r !== 'ok' && x.r !== 'missing' && x.r !== 'bad' && x.r !== 'accepted') continue;
    if (typeof x.at !== 'string') continue;
    out[id] = {
      s: x.s, x: x.x, r: x.r, at: x.at,
      ...(Number.isSafeInteger(x.i) ? { i: x.i } : {}), ...(Number.isSafeInteger(x.n) ? { n: x.n } : {}),
    };
  }
  return out;
}

/** The mark for exactly these keys, or null when they were never checked on this account. */
export function markFor(map: KeyLogMap | null, id: string, s: string, x: string): KeyLogMark | null {
  const e = map?.[id];
  return e && e.s === s && e.x === x ? e.r : null;
}

/**
 * Should this device refuse to seal new keys to these keys? Yes when the log check failed and the user did
 * not accept it, and (fail closed) while the log looks forked for keys that were never confirmed logged.
 */
export function logRefuses(mark: KeyLogMark | null, alarm: boolean): boolean {
  if (mark === 'missing' || mark === 'bad') return true;
  return alarm && mark !== 'ok' && mark !== 'accepted';
}

/** The new mark after a check: a failure never overrides the user's acceptance of the same keys. */
export function nextMark(prev: KeyLogMark | null, verdict: KtVerdict): KeyLogMark | null {
  if (verdict === 'ok') return 'ok';
  if (verdict === 'missing' || verdict === 'bad') return prev === 'accepted' ? 'accepted' : verdict;
  return null;
}
