'use client';
// Time capsules: a post that nobody, not even its readers, the author's devices or Kithwall, can open
// before a chosen time. The post payload is encrypted with tlock (timelock encryption, drand + IBE): the
// key that opens it is drand quicknet's signature for one future round, which the League of Entropy
// publishes only when that round arrives. The capsule then travels inside the post's ordinary end-to-end
// encrypted envelope, so after the date it is still readable only by the post's audience.
//
// Beacons come through our own relay (/api/drand/…): devices don't contact a third party and capsules open
// where drand's domains are blocked. Every beacon is verified against the chain's pinned public key below,
// so the relay can't forge one.
import { Buffer, HttpCachingChain, HttpChainClient, roundAt, timelockDecrypt, timelockEncrypt } from 'tlock-js';
import { defaultChainOptions } from 'drand-client';
import type { PostPayload } from '../types';

const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const PUBLIC_KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
/** quicknet: genesis and period (seconds), pinned so the opening round never depends on the network. */
const GENESIS = 1692803367;
const PERIOD = 3;

export type Capsule = NonNullable<PostPayload['capsule']>;

/** Capsules open from one hour to 25 years ahead. */
export const CAPSULE_MIN_MS = 60 * 60_000;
export const CAPSULE_MAX_MS = 25 * 365 * 86_400_000;

let client: HttpChainClient | null = null;
function drand(): HttpChainClient {
  if (client) return client;
  const opts = { ...defaultChainOptions, chainVerificationParams: { chainHash: CHAIN_HASH, publicKey: PUBLIC_KEY } };
  const base = typeof location !== 'undefined' ? location.origin : '';
  client = new HttpChainClient(new HttpCachingChain(`${base}/api/drand/${CHAIN_HASH}`, opts), opts);
  return client;
}

/** The drand round published at (or just after) this time. */
export function roundFor(when: Date): number {
  return roundAt(when.getTime(), { genesis_time: GENESIS, period: PERIOD } as Parameters<typeof roundAt>[1]);
}

/** Seal a whole post payload so it opens at `opens`. */
export async function sealCapsule(inner: PostPayload, opens: Date): Promise<Capsule> {
  const round = roundFor(opens);
  const ct = await timelockEncrypt(round, Buffer.from(JSON.stringify(inner), 'utf-8'), drand());
  return { opens: opens.toISOString(), round, ct };
}

const opened = new Map<string, PostPayload>();

/** Open a capsule whose time has come (throws if drand hasn't reached the round or can't be reached). */
export async function openCapsule(c: Capsule): Promise<PostPayload> {
  const hit = opened.get(c.ct);
  if (hit) return hit;
  const plain = await timelockDecrypt(c.ct, drand());
  const v = JSON.parse(plain.toString('utf-8')) as PostPayload;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad capsule');
  delete v.capsule; // never nested
  opened.set(c.ct, v);
  return v;
}

export function capsuleReady(c: Capsule, now = Date.now()): boolean {
  return Date.parse(c.opens) <= now;
}
