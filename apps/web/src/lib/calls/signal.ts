// Call signalling, sealed (docs/v2/04-calls.md §3). Pure functions: no React, no Supabase, so vitest can
// exercise them directly.
//
// Every signalling message (ring, join, offer, answer, decline, hang-up …) is an ordinary Kithwall
// envelope (packages/crypto envelope.ts): encrypted under the conversation's audience key for the epoch
// and signed with the sender's identity key. The header binds the type ("call-signal"), a fresh signal
// id, the author, the conversation and the audience epoch, so a blob can't be replayed into another
// conversation or attributed to another member.
//
// On the wire Realtime sees { v, i, e, env } (plus `c`, the conversation id, on the per-person ring
// topic where the receiver needs it to find the key). The AUTHOR IS NOT on the wire: the receiver tries
// the identity keys of the conversation's members (at most 8) until one verifies.
import { openEnvelope, sealEnvelope, type Envelope, type EnvelopeHeader } from '@kithwall/crypto';

export const SIGNAL_TYPE = 'call-signal';
/** Signals older (or further in the future) than this are dropped (replay window). */
export const MAX_SIGNAL_AGE_MS = 90_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEV_RE = /^[A-Za-z0-9_-]{6,32}$/;
const MAX_SDP = 64 * 1024;

/** One device in a call: "<user id>:<random per-page device id>". */
export type Endpoint = string;
export const endpointOf = (userId: string, dev: string): Endpoint => `${userId}:${dev}`;
export function parseEndpoint(ep: string): { userId: string; dev: string } | null {
  const i = ep.indexOf(':');
  if (i < 0) return null;
  const userId = ep.slice(0, i);
  const dev = ep.slice(i + 1);
  return UUID_RE.test(userId) && DEV_RE.test(dev) ? { userId, dev } : null;
}

export type SignalBody =
  /** Caller → each callee's ring topic. `key` is the per-call frame-encryption key (base64url, 32 bytes). */
  | { k: 'ring'; video: boolean; key: string }
  /** Caller gave up before anyone answered. */
  | { k: 'cancel' }
  /** A device entered the call (accepted, or the caller starting it). `fe`: can do frame encryption. */
  | { k: 'join'; fe: boolean; video: boolean }
  /** Reply to a join, addressed to the newcomer. */
  | { k: 'here'; fe: boolean; video: boolean }
  /** "Is this call still ringing?" (a device opened from a push). */
  | { k: 'probe' }
  | { k: 'decline' }
  | { k: 'busy' }
  | { k: 'offer'; sdp: string; fe: boolean }
  | { k: 'answer'; sdp: string; fe: boolean }
  /** Microphone / camera state, so the others can show "muted" and an avatar instead of black video. */
  | { k: 'state'; mic: boolean; cam: boolean }
  | { k: 'leave' };

export type SignalKind = SignalBody['k'];

export interface Signal {
  /** Call id (= the id of the call notice in the thread). */
  call: string;
  /** Sending device. */
  from: Endpoint;
  /** Addressed device, or absent for everyone in the call. */
  to?: Endpoint;
  ts: number;
  body: SignalBody;
}

export interface Wire {
  v: 1;
  /** Signal id (uuid), part of the signed header; used to drop duplicates. */
  i: string;
  /** Audience epoch the envelope is sealed under. */
  e: number;
  /** Conversation id: only on the ring topic. */
  c?: string;
  env: Envelope;
}

export interface ConvKeys { id: string; audienceId: string }

export function signalHeader(conv: ConvKeys, id: string, author: string, epoch: number): EnvelopeHeader {
  return { v: 1, type: SIGNAL_TYPE, id, author, wall: conv.id, audience: { id: conv.audienceId, epoch } };
}

export function sealSignal(args: {
  conv: ConvKeys; epoch: number; key: Uint8Array; signPriv: Uint8Array; author: string; signal: Signal; id?: string; withConv?: boolean;
}): Wire {
  const id = args.id ?? crypto.randomUUID();
  const env = sealEnvelope({ header: signalHeader(args.conv, id, args.author, args.epoch), payload: args.signal, audienceKey: args.key, signPriv: args.signPriv });
  return { v: 1, i: id, e: args.epoch, ...(args.withConv ? { c: args.conv.id } : {}), env };
}

export function isWire(x: unknown): x is Wire {
  const w = x as Wire | null;
  return !!w && typeof w === 'object' && w.v === 1 && typeof w.i === 'string' && UUID_RE.test(w.i)
    && Number.isSafeInteger(w.e) && w.e >= 0 && !!w.env && typeof w.env === 'object'
    && (w.c === undefined || (typeof w.c === 'string' && UUID_RE.test(w.c)));
}

function validBody(b: unknown): b is SignalBody {
  const x = b as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return false;
  const bool = (v: unknown) => typeof v === 'boolean';
  const sdp = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP;
  switch (x.k) {
    case 'ring': return bool(x.video) && typeof x.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x.key);
    case 'join': case 'here': return bool(x.fe) && bool(x.video);
    case 'offer': case 'answer': return sdp(x.sdp) && bool(x.fe);
    case 'state': return bool(x.mic) && bool(x.cam);
    case 'cancel': case 'probe': case 'decline': case 'busy': case 'leave': return true;
    default: return false;
  }
}

export type OpenResult =
  | { ok: true; author: string; signal: Signal }
  | { ok: false; reason: 'malformed' | 'no-key' | 'unverified' | 'stale' | 'mismatch' };

/**
 * Verify and decrypt a wire message. `keyFor(epoch)` returns the conversation key for that epoch (or
 * null); `members` are the people allowed to signal in this conversation with their identity keys.
 */
export function openSignal(wire: unknown, args: {
  conv: ConvKeys; keyFor: (epoch: number) => Uint8Array | null; members: { id: string; signPub: Uint8Array }[]; now?: number;
}): OpenResult {
  if (!isWire(wire)) return { ok: false, reason: 'malformed' };
  if (wire.c !== undefined && wire.c !== args.conv.id) return { ok: false, reason: 'mismatch' };
  const key = args.keyFor(wire.e);
  if (!key) return { ok: false, reason: 'no-key' };
  for (const m of args.members) {
    let s: Signal;
    try {
      s = openEnvelope<Signal>({ header: signalHeader(args.conv, wire.i, m.id, wire.e), envelope: wire.env, audienceKey: key, signPub: m.signPub });
    } catch {
      continue;
    }
    if (!s || typeof s !== 'object' || typeof s.call !== 'string' || !UUID_RE.test(s.call) || typeof s.ts !== 'number') return { ok: false, reason: 'malformed' };
    const from = typeof s.from === 'string' ? parseEndpoint(s.from) : null;
    if (!from || from.userId !== m.id) return { ok: false, reason: 'mismatch' };
    if (s.to !== undefined && (typeof s.to !== 'string' || !parseEndpoint(s.to))) return { ok: false, reason: 'malformed' };
    if (!validBody(s.body)) return { ok: false, reason: 'malformed' };
    if (Math.abs((args.now ?? Date.now()) - s.ts) > MAX_SIGNAL_AGE_MS) return { ok: false, reason: 'stale' };
    return { ok: true, author: m.id, signal: s };
  }
  return { ok: false, reason: 'unverified' };
}

/** Remembers recently seen signal ids (drops replays and duplicate deliveries). */
export class SeenIds {
  private ids = new Map<string, number>();
  constructor(private ttl = MAX_SIGNAL_AGE_MS * 2) {}
  /** True the first time an id is seen. */
  add(id: string, now = Date.now()): boolean {
    if (this.ids.has(id)) return false;
    this.ids.set(id, now);
    if (this.ids.size > 2000) for (const [k, t] of this.ids) if (now - t > this.ttl) this.ids.delete(k);
    return true;
  }
}
