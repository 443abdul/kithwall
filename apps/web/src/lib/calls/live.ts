'use client';
// Late join (docs/v2/04-calls.md §14): which group calls are going on right now in my conversations, so
// the chat header and the conversation list can offer "Call in progress · Join".
//
// Nothing here talks to the server. The hints arrive as sealed `live` signals on my private ring topic,
// sent by one participant of the call (the engine, engine.ts) to the conversation members who aren't in
// it: when someone joins or leaves, and every LIVE_MS while the call lasts. A hint that isn't refreshed
// expires after LIVE_TTL_MS, so a call whose last participant vanished (closed laptop, lost network)
// disappears by itself; a participant who leaves last says so at once (n = 0).
//
// This module is deliberately tiny and engine-free: the conversation list imports it without loading
// WebRTC. The frame key in a hint stays in memory only.
import { useSyncExternalStore } from 'react';

/** A participant re-announces the call this often. */
export const LIVE_MS = 25_000;
/** A hint not refreshed for this long is dropped (two lost announcements, then gone). */
export const LIVE_TTL_MS = 65_000;

export interface LiveCall {
  convId: string;
  callId: string;
  /** People (distinct accounts) in the call, as the announcing participant sees it. */
  n: number;
  video: boolean;
  /** The per-call frame key (base64url), needed to join. Memory only. */
  key: string;
  at: number;
}

const live = new Map<string, LiveCall>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  listeners.forEach((l) => l());
}

export function setLiveCall(h: Omit<LiveCall, 'at'>, now = Date.now()) {
  const prev = live.get(h.convId);
  const next: LiveCall = { ...h, at: now };
  live.set(h.convId, next);
  const t = timers.get(h.convId);
  if (t) clearTimeout(t);
  timers.set(h.convId, setTimeout(() => {
    if (live.get(h.convId) === next) { live.delete(h.convId); timers.delete(h.convId); changed(); }
  }, LIVE_TTL_MS));
  if (!prev || prev.callId !== next.callId || prev.n !== next.n || prev.video !== next.video) changed();
}

/** The call is over (n = 0), or I'm in it now: forget the hint (only for that call, when given). */
export function clearLiveCall(convId: string, callId?: string) {
  const prev = live.get(convId);
  if (!prev || (callId && prev.callId !== callId)) return;
  live.delete(convId);
  const t = timers.get(convId);
  if (t) clearTimeout(t);
  timers.delete(convId);
  changed();
}

/** Locked or signed out: forget everything (the keys with it). */
export function clearAllLiveCalls() {
  if (!live.size) return;
  timers.forEach(clearTimeout);
  timers.clear();
  live.clear();
  changed();
}

export function getLiveCall(convId: string): LiveCall | null {
  return live.get(convId) ?? null;
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The call going on in this conversation, if any (re-renders when hints change). */
export function useLiveCall(convId: string | null | undefined): LiveCall | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return convId ? getLiveCall(convId) : null;
}

// ------------------------------------------------------------------------------------- pure helpers
// (unit-tested in calls.test.ts)

/**
 * Who announces the call to the others: the participant whose endpoint sorts first among everyone
 * connected (myself included). Every participant can work it out alone, so exactly one sends, and the
 * next one takes over when that person leaves.
 */
export function isAnnouncer(myEp: string, peerEps: string[]): boolean {
  return peerEps.every((ep) => myEp < ep);
}

/** Members to tell: everyone in the conversation who isn't in the call on any device. */
export function liveTargets(members: string[], participants: Iterable<string>): string[] {
  const inCall = new Set(participants);
  return members.filter((m) => !inCall.has(m));
}
