'use client';
// The call engine (docs/v2/04-calls.md). One instance per tab; React reads it through useCall().
//
//  - Ringing: the caller writes a call notice (start_call RPC → push for offline people, missed-call
//    line in the thread) and sends a sealed `ring` to each callee's private `ring:<user id>` topic.
//  - Signalling: everyone in the call joins the private `call:<conversation id>` topic. Every message is
//    a sealed + signed envelope (signal.ts). Realtime only relays opaque blobs.
//  - Media: a full mesh of RTCPeerConnections (≤ 8 people). The lower endpoint id makes the offer, so
//    there is never glare. Offers and answers are sent at once and ICE candidates follow in sealed,
//    cumulative `cand` messages (trickle ICE, docs §12), when both ends say they can (`tr`); with an
//    older client, ICE is gathered before the SDP is sent ("vanilla" ICE). DTLS fingerprints travel
//    inside the signed SDP, so the DTLS-SRTP keys are authenticated end to end; TURN relays only see
//    ciphertext.
//  - Speed (docs §12): microphone/camera, the call notice, the conversation key, the call channel and the
//    TURN credentials (prefetched when the chat opened) are all set up in parallel; the callee's TURN
//    credentials are fetched while it rings.
//  - Frame encryption (insertable streams) is added where both ends support it (e2ee.ts).
//  - Bad networks (docs §11): a quality controller per peer (quality.ts) reads getStats every 2 s and
//    sets the video tier / Opus bitrate / RED; Opus is negotiated with FEC + DTX (sdp.ts); ICE restarts
//    with back-off on disconnects and network changes; handshake messages are retried idempotently.
import { b64u, randomBytes } from '@kithwall/crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { sb, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../supabase';
import { netUrl } from '../net/runtime';
import { getSession, identity, onLock } from '../keys/session';
import { keyring } from '../keys/keyring';
import { people } from '../people';
import { conversationKey, getConversation, type ConversationSummary } from '../messages';
import { isHiddenChat, isRevealed } from '../safety/hidden';
import { getAppLock } from '../safety/applock';
import { getCallPrefs, loadCallPrefs } from './prefs';
import { IDLE, isLive, step, type MachineEvent, type MachineState } from './machine';
import { endpointOf, openSignal, parseEndpoint, sealSignal, SeenIds, UUID_RE, type Signal, type SignalBody, type Wire } from './signal';
import { FrameCrypto, frameMode, type FrameMode, type FrameStats } from './e2ee';
import { callSafetyCode, sdpFingerprint, type SafetyCode } from './safety';
import { endTone, startTone, stopTone } from './tones';
import { getIceConfig, prefetchIceConfig, type IceConfig } from './turn';
import { capVideoBandwidth, firstAudioCodec, isMobileUa, orderAudioCodecs, orderVideoCodecs, tuneOpus, videoStartBitrate } from './sdp';
import { getCallDevices, mediaErr, micAllowed, micConstraints, type MediaErr } from './devices';
import { nativeCallActive, nativeCallEnded } from '../native/calls';
import {
  deltaLoss,
  meshCeiling, PAUSED, QualityController, SAVER_AUDIO, shareUplink, startTier, videoEncoding,
  type Decision, type Limitation, type NetSample, type Quality, type QualityReason, type Tier,
} from './quality';

export const MAX_CALL_PEOPLE = 8;
const RING_MS = 45_000;
const CONNECT_MS = 30_000;
/** Slow links (2G/3G): connecting is given longer before we give up. */
const CONNECT_SLOW_MS = 45_000;
/** Vanilla ICE: wait this long for gathering, then send what we have … */
const ICE_GATHER_MS = 3_000;
/** … unless we have no candidate yet (a TURN allocation over a slow or TCP/TLS-only link): then up to this. */
const ICE_GATHER_MAX_MS = 12_000;
/** A peer that stays unreachable this long is dropped (a network switch on a phone can take a while). */
const RECONNECT_MS = 30_000;
/** 'disconnected' often heals by itself (a burst of loss); restart ICE if it hasn't after this. */
const DISCONNECT_GRACE_MS = 2_000;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 16_000;
/** No answer to an offer after this (× 1.5 each try): send it again (Realtime can drop a message). */
const OFFER_RETRY_MS = 5_000;
const OFFER_TRIES = 4;
/** Accepted but nobody has connected yet: say `join` again. */
const JOIN_RETRY_MS = 4_000;
/** Still ringing: ring again (a callee whose connection blipped missed the first one). */
const RERING_MS = 10_000;
const STATS_MS = 2_000;
const ENDED_SHOW_MS = 2_500;
/** An ending that needs reading (couldn't connect, no microphone, relay unreachable) stays up longer. */
const ENDED_ERROR_MS = 20_000;
/** Trickle ICE: send the first candidate at once, then batch the next ones this long. */
const CAND_BATCH_MS = 150;
/** Where the other side's video encoder starts on a normal link (x-google-start-bitrate, kbps). */
const VIDEO_START_KBPS = 800;

export type { MediaErr };
/** The caller's progress before anyone is connected: Calling… → Ringing… → Connecting… */
export type Progress = 'calling' | 'ringing' | 'connecting';
type Cand = [string, number, string];

export type PeerState = 'connecting' | 'connected' | 'reconnecting';
export type { Quality, QualityReason };

export interface PeerView {
  ep: string;
  userId: string;
  stream: MediaStream;
  state: PeerState;
  mic: boolean;
  cam: boolean;
  /** Their video to me is paused because their link can't carry it. */
  videoPaused: boolean;
  quality: Quality | null;
  reason: QualityReason | null;
  relayed: boolean | null;
  safety: SafetyCode | null;
  frames: boolean;
  bytesReceived: number;
}

/** Whose connection is weak: mine, a named person's, or "somewhere on the link" (can't tell). */
export type Weak = { who: 'me' } | { who: 'peer'; userId: string } | { who: 'link' } | null;

export interface CallSnapshot {
  m: MachineState;
  callId: string | null;
  convId: string | null;
  conv: ConversationSummary | null;
  isCaller: boolean;
  /** Who rang (incoming). */
  caller: string | null;
  video: boolean;
  /** An incoming call from a hidden chat: no name or picture until the chat is revealed. */
  masked: boolean;
  connectedAt: number | null;
  local: MediaStream | null;
  mic: boolean;
  cam: boolean;
  facing: 'user' | 'environment';
  peers: PeerView[];
  minimized: boolean;
  frameMode: FrameMode;
  frameStats: FrameStats | null;
  /** 'on': relay-only (IP hidden). 'off': direct allowed. 'unavailable': wanted relay, but no TURN server. */
  relay: 'on' | 'off' | 'unavailable';
  sinkId: string;
  /** Data saver for this call (from Settings, the browser's Save-Data, or the in-call toggle). */
  saver: boolean;
  /** Voice only: my camera is off and I've asked the others not to send video. */
  voiceOnly: boolean;
  weak: Weak;
  /** Offer "Weak connection — switch to voice only?" */
  suggestVoice: boolean;
  /** Before anyone connected: what's happening (shown as the status). */
  progress: Progress | null;
  /** Why the microphone couldn't be used (the call ended with 'no-media'). */
  mediaError: MediaErr | null;
  /** The camera couldn't be used for a video call, so it carries on as a voice call. */
  camError: MediaErr | null;
}

interface Applied { audio: string; video: string }

interface Peer {
  ep: string;
  userId: string;
  pc: RTCPeerConnection;
  stream: MediaStream;
  initiator: boolean;
  fe: boolean;
  state: PeerState;
  mic: boolean;
  cam: boolean;
  /** Their video is paused for the network (their `vp`). */
  vp: boolean;
  /** Their own view of their connection (their `net`), if they sent one. */
  net: 0 | 1 | 2 | null;
  /** The best tier they want from me (their `rx`). */
  rx: Tier;
  ctl: QualityController;
  decision: Decision | null;
  applied: Applied;
  sentVp: boolean;
  relayed: boolean | null;
  safety: SafetyCode | null;
  lostTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartAttempts: number;
  lastRestartAt: number;
  offerTimer: ReturnType<typeof setTimeout> | null;
  /** Idempotency: the last offer we answered and our answer to it. */
  lastOffer: string | null;
  lastAnswer: string | null;
  prev: { lost: number; recv: number; t: number; aBytes: number; vBytes: number; sent: Record<string, number>; rLost: Record<string, number> };
  /** Uplink to this peer as last measured (debug / tests). */
  tx: { audioBps: number; videoBps: number; height: number; fps: number; aob: number | null; budget: number | null; rtt: number | null; loss: number; limitation: Limitation | null; red: boolean };
  uplink: Quality;
  bytesReceived: number;
  paramQueue: Promise<void>;
  /** RED (audio redundancy) is first in the audio codec order of the current negotiation. */
  redNeg: boolean;
  /** Offerer: the answerer asked for RED (`reneg` red). */
  peerRed: boolean;
  /** Answerer: what I last asked the offerer for. */
  askedRed: boolean;
  /** The Opus packet time I last asked this peer for (in the SDP I sent), and when we last renegotiated it. */
  ptime: 20 | 60;
  lastRenegAt: number;
  /** Trickle ICE with this peer (both ends announced `tr`). */
  tr: boolean;
  /** My candidates for my current ICE generation (ufrag `candU`), cumulative; `candDone`: gathering finished. */
  cands: Cand[];
  candU: string;
  candDone: boolean;
  candTimer: ReturnType<typeof setTimeout> | null;
  /** Their candidates already handed to the connection ("<ufrag> <candidate>"). */
  added: Set<string>;
  /** An offer being handled right now (a repeat that arrives meanwhile is ignored). */
  handling: string | null;
}

interface ConvCtx { id: string; audienceId: string; members: string[]; summary: ConversationSummary }

const EMPTY: CallSnapshot = {
  m: IDLE, callId: null, convId: null, conv: null, isCaller: false, caller: null, video: false, masked: false,
  connectedAt: null, local: null, mic: true, cam: false, facing: 'user', peers: [], minimized: false,
  frameMode: null, frameStats: null, relay: 'on', sinkId: '', saver: false, voiceOnly: false, weak: null, suggestVoice: false,
  progress: null, mediaError: null, camError: null,
};

const DEV_ID = typeof window === 'undefined' ? 'server' : b64u.encode(randomBytes(9));

interface NetInfo extends EventTarget { effectiveType?: string; saveData?: boolean; downlink?: number; type?: string }
function netInfo(): NetInfo | null {
  return typeof navigator !== 'undefined' ? ((navigator as unknown as { connection?: NetInfo }).connection ?? null) : null;
}
const slowLink = () => { const e = netInfo()?.effectiveType; return e === 'slow-2g' || e === '2g' || e === '3g'; };
const verySlowLink = () => { const e = netInfo()?.effectiveType; return e === 'slow-2g' || e === '2g'; };
const debugOn = () => { try { return localStorage.getItem('kw.calls.debug') === '1'; } catch { return false; } };
/** Trickle ICE is on unless a debug/test switch turns it off (to measure or interoperate like an older client). */
const trickleOn = () => { try { return localStorage.getItem('kw.calls.noTrickle') !== '1'; } catch { return true; } };
const ufragOf = (sdp: string | undefined) => (sdp ? /^a=ice-ufrag:(\S+)/m.exec(sdp)?.[1] ?? null : null);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function restBroadcast(topic: string, payload: unknown, keepalive = false): Promise<boolean> {
  const token = (await sb().auth.getSession()).data.session?.access_token;
  if (!token) return false;
  const res = await fetch(netUrl(`${SUPABASE_URL}/realtime/v1/api/broadcast`), {
    method: 'POST', keepalive, credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic, event: 'sig', payload, private: true }] }),
  });
  await res.body?.cancel().catch(() => undefined);
  return res.ok;
}

/**
 * Vanilla ICE: resolve when gathering completes, or after ICE_GATHER_MS if we have at least one
 * candidate. With none yet (relay-only over a slow link, or a network where only TURN over TCP/TLS 443
 * gets through, whose allocation takes several round trips) keep waiting for the first one, then give
 * the rest a moment, up to ICE_GATHER_MAX_MS.
 */
function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let have = false;
    let soft = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCand);
      clearTimeout(t1); clearTimeout(t2); if (grace) clearTimeout(grace);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const onCand = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate?.candidate) return;
      have = true;
      if (soft && !grace) grace = setTimeout(done, 400);
    };
    const t1 = setTimeout(() => { soft = true; if (have) done(); }, ICE_GATHER_MS);
    const t2 = setTimeout(done, ICE_GATHER_MAX_MS);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCand);
  });
}

/** Codec order for one transceiver (sdp.ts has the reasoning). `red`: RED first, so it is sent. */
function setCodecPrefs(t: RTCRtpTransceiver, kind: 'audio' | 'video', frames: boolean, red = false) {
  try {
    if (typeof t.setCodecPreferences !== 'function' || typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities(kind);
    if (!caps?.codecs.length) return;
    const list = kind === 'audio' ? orderAudioCodecs(caps.codecs, red) : orderVideoCodecs(caps.codecs, { frames, mobile: isMobileUa(navigator.userAgent) });
    if (list.length && list !== caps.codecs) t.setCodecPreferences(list);
  } catch { /* keep the browser's defaults */ }
}


class CallEngine {
  private snap: CallSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private userId: string | null = null;
  private ringCh: RealtimeChannel | null = null;
  private callCh: RealtimeChannel | null = null;
  private callChConv: string | null = null;
  private callChReady: Promise<void> | null = null;
  private conv: ConvCtx | null = null;
  private convKey: { key: Uint8Array; epoch: number } | null = null;
  private callKey: Uint8Array | null = null;
  private frames: FrameCrypto | null = null;
  private ice: IceConfig | null = null;
  private relayOnly = true;
  private peers = new Map<string, Peer>();
  private roster = new Map<string, { fe: boolean; video: boolean; tr: boolean }>();
  private seen = new SeenIds();
  private ended = new Set<string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private netTimer: ReturnType<typeof setTimeout> | null = null;
  private local: MediaStream | null = null;
  private cleanup: (() => void)[] = [];
  /** My own connection as I see it (sent to the others as `net`), with a little hysteresis. */
  private myNet: 0 | 1 | 2 = 0;
  private myNetCand: 0 | 1 | 2 = 0;
  private sentNet: 0 | 1 | 2 = 0;
  private weakPolls = 0;
  private suggestDismissed = false;
  private offline = false;
  /** Debug/tests only (kw.calls.debug): stats overrides, so the controller can be driven synthetically. */
  private netOverride: Partial<NetSample> | null = null;
  /** Candidates that arrived before (or for) a peer's remote description, per endpoint (trickle ICE). */
  private earlyCands = new Map<string, { u: string; c: Cand[] }>();
  /** The microphone (and camera) of this call: resolves true once captured, false if that failed. */
  private mediaReady: Promise<boolean> | null = null;
  /** Bumped when a call ends, so a capture that finishes afterwards is released at once. */
  private mediaGen = 0;
  /** ICE restarts this call (debug/tests). */
  restarts = 0;
  readonly myEp = () => endpointOf(this.userId ?? '', DEV_ID);

  // ------------------------------------------------------------------------------------- store
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  get = () => this.snap;
  private set(patch: Partial<CallSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  private peerViews(): PeerView[] {
    return [...this.peers.values()].map((p) => ({
      ep: p.ep, userId: p.userId, stream: p.stream, state: p.state, mic: p.mic, cam: p.cam, videoPaused: p.vp,
      quality: p.decision?.quality ?? null, reason: p.decision?.reason ?? null,
      relayed: p.relayed, safety: p.safety, frames: p.fe, bytesReceived: p.bytesReceived,
    }));
  }
  private bumpPeers() { this.set({ peers: this.peerViews() }); }
  private dispatch(e: MachineEvent) {
    const before = this.snap.m;
    const m = step(before, e);
    if (m === before) return;
    const patch: Partial<CallSnapshot> = { m };
    if (m.phase === 'active' && !this.snap.connectedAt) patch.connectedAt = Date.now();
    this.set(patch);
    if (m.phase === 'active') stopTone();
    if (m.phase === 'ended' && before.phase !== 'ended') this.finish();
  }

  // ------------------------------------------------------------------------------- lifecycle
  /** Listen for incoming calls (signed-in, unlocked). Idempotent. */
  start(userId: string) {
    if (this.userId === userId && this.ringCh) return;
    this.stop();
    this.userId = userId;
    void loadCallPrefs().catch(() => undefined);
    this.ringCh = sb().channel(`ring:${userId}`, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'sig' }, ({ payload }) => { void this.onRing(payload).catch((e) => console.warn('call ring', e)); })
      .subscribe((status, err) => { if (status === 'CHANNEL_ERROR') console.warn('call ring channel unavailable', err?.message ?? ''); });
    const hide = () => { if (isLive(this.snap.m.phase)) this.hangup(); };
    window.addEventListener('pagehide', hide);
    const offLock = onLock(() => { this.hangup(); this.stop(); });
    // Network changes (Wi-Fi ↔ mobile data, coming back online): the old ICE path is probably gone, so
    // restart ICE right away instead of waiting for the connection to time out.
    const online = () => { this.offline = false; this.onNetworkChange(); };
    const offline = () => { this.offline = true; if (this.inCall()) this.refreshWeak(); };
    const conn = netInfo();
    const change = () => this.onNetworkChange();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    conn?.addEventListener?.('change', change);
    this.cleanup.push(() => window.removeEventListener('pagehide', hide), offLock,
      () => window.removeEventListener('online', online), () => window.removeEventListener('offline', offline),
      () => conn?.removeEventListener?.('change', change));
    if (debugOn()) {
      (window as unknown as { __kwCall?: unknown }).__kwCall = {
        engine: this,
        pcs: () => [...this.peers.values()].map((p) => p.pc),
        peers: () => [...this.peers.values()].map((p) => ({ ep: p.ep, tier: p.decision?.tier ?? null, audio: p.decision?.audioBitrate ?? null, red: p.decision?.red ?? false, quality: p.decision?.quality ?? null, reason: p.decision?.reason ?? null, rx: p.rx, vp: p.vp, net: p.net, redNeg: p.redNeg, upHold: p.ctl.upHold, tx: p.tx, state: p.state })),
        setNet: (o: Partial<NetSample> | null) => { this.netOverride = o; },
        network: () => this.onNetworkChange(true),
      };
    }
  }

  stop() {
    if (this.ringCh) void sb().removeChannel(this.ringCh);
    this.ringCh = null;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.userId = null;
  }

  get running() { return !!this.userId; }

  // ------------------------------------------------------------------------------- conversation
  private async loadConv(convId: string): Promise<ConvCtx | null> {
    const summary = await getConversation(convId);
    if (!summary) return null;
    await people.ensure(summary.members);
    return { id: summary.id, audienceId: summary.audience_id, members: summary.members, summary };
  }

  private memberKeys(conv: ConvCtx) {
    return conv.members.flatMap((id) => {
      const p = people.get(id);
      try { return p ? [{ id, signPub: b64u.decode(p.sign_pub) }] : []; } catch { return []; }
    });
  }

  private async keyFor(conv: ConvCtx, epoch: number): Promise<Uint8Array | null> {
    let k = keyring.get(conv.audienceId, epoch);
    if (!k) { await keyring.load().catch(() => undefined); k = keyring.get(conv.audienceId, epoch); }
    return k;
  }

  private seal(conv: ConvCtx, key: { key: Uint8Array; epoch: number }, signal: Signal, withConv = false) {
    return sealSignal({ conv: { id: conv.id, audienceId: conv.audienceId }, epoch: key.epoch, key: key.key, signPriv: identity().signPriv, author: this.userId!, signal, withConv });
  }

  private signal(body: SignalBody, to?: string): Signal {
    return { call: this.snap.callId!, from: this.myEp(), ...(to ? { to } : {}), ts: Date.now(), body };
  }

  /** One delivery attempt: the joined channel, else Realtime's REST endpoint. */
  private async deliver(topic: string, wire: Wire, keepalive: boolean): Promise<boolean> {
    const ch = this.callCh;
    if (!keepalive && ch && this.callChConv === this.conv?.id && (ch as unknown as { state?: string }).state === 'joined') {
      const r = await ch.send({ type: 'broadcast', event: 'sig', payload: wire }).catch(() => 'error');
      if (r === 'ok') return true;
    }
    return restBroadcast(topic, wire, keepalive).catch(() => false);
  }

  /**
   * Send to everyone in the call channel (or to one endpoint, still over the channel). With `retries`,
   * a failed delivery is retried with back-off using the SAME sealed message (same signal id), so a
   * copy that did get through is dropped as a duplicate by the receiver: retries are idempotent.
   */
  private async send(body: SignalBody, to?: string, keepalive = false, retries = 0): Promise<boolean> {
    const conv = this.conv;
    const key = this.convKey;
    if (!conv || !key || !this.snap.callId || !this.userId) return false;
    const wire = this.seal(conv, key, this.signal(body, to));
    const callId = this.snap.callId;
    for (let i = 0; ; i++) {
      if (await this.deliver(`call:${conv.id}`, wire, keepalive)) return true;
      if (i >= retries || this.snap.callId !== callId || !this.inCall()) return false;
      await sleep(Math.min(8_000, 500 * 2 ** i));
    }
  }

  private joinCallChannel(convId: string): Promise<void> {
    if (this.callCh && this.callChConv === convId && this.callChReady) return this.callChReady;
    this.leaveCallChannel();
    this.callChConv = convId;
    this.callChReady = new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      this.callCh = sb().channel(`call:${convId}`, { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'sig' }, ({ payload }) => { void this.onSignal(payload).catch((e) => console.warn('call signal', e)); })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
          if (status === 'CHANNEL_ERROR') { console.warn('call channel unavailable', err?.message ?? ''); clearTimeout(t); resolve(); }
        });
    });
    return this.callChReady;
  }

  private leaveCallChannel() {
    if (this.callCh) void sb().removeChannel(this.callCh);
    this.callCh = null;
    this.callChConv = null;
    this.callChReady = null;
  }

  // ------------------------------------------------------------------------------------ media
  /** Capture size: 720p only where it can be used; phones, data saver and slow links capture 360p (less CPU). */
  private videoConstraints(facing: 'user' | 'environment' | { exact: 'user' | 'environment' }): MediaTrackConstraints {
    const small = this.snap.saver || slowLink() || (typeof navigator !== 'undefined' && isMobileUa(navigator.userAgent));
    // The camera chosen in "Test camera and microphone", for the first capture of a call.
    const cam = facing === 'user' ? getCallDevices().cam : undefined;
    const which: MediaTrackConstraints = cam ? { deviceId: { ideal: cam } } : { facingMode: facing };
    return small
      ? { ...which, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }
      : { ...which, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
  }

  /**
   * Capture the microphone (and camera for a video call). A video call whose camera fails carries on as a
   * voice call (camError); a microphone that fails ends the call with a reason the screen can explain
   * (mediaError). Never leaves a device open when the call ended meanwhile.
   */
  private async getMedia(video: boolean): Promise<boolean> {
    const gen = this.mediaGen;
    const gum = (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c);
    let stream: MediaStream;
    try {
      stream = await gum({ audio: micConstraints(), video: video ? this.videoConstraints('user') : false });
    } catch (e) {
      if (!video) { this.set({ mediaError: mediaErr(e) }); return false; }
      try {
        stream = await gum({ audio: micConstraints(), video: false });
        this.set({ camError: mediaErr(e) });
      } catch (e2) { this.set({ mediaError: mediaErr(e2) }); return false; }
    }
    // Hung up while the permission prompt or the camera was starting: release it at once.
    if (gen !== this.mediaGen || !isLive(this.snap.m.phase)) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.local = stream;
    stream.getTracks().forEach((t) => this.watchTrack(t));
    this.set({ local: stream, mic: true, cam: stream.getVideoTracks().length > 0, facing: 'user' });
    return true;
  }

  /** Media for offers/answers: wait for the capture started by place()/accept(). */
  private async haveMedia(): Promise<boolean> {
    if (this.local) return true;
    return this.mediaReady ? this.mediaReady : false;
  }

  /** A device went away mid-call (unplugged headset, another app took the camera): recover by itself. */
  private watchTrack(t: MediaStreamTrack) {
    t.addEventListener('ended', () => {
      if (!this.local?.getTracks().includes(t) || !isLive(this.snap.m.phase)) return;
      void this.recoverTrack(t);
    });
  }

  private async recoverTrack(old: MediaStreamTrack) {
    if (!this.local) return;
    this.local.removeTrack(old);
    if (old.kind === 'audio') {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
        const track = s.getAudioTracks()[0]!;
        if (!this.local || !isLive(this.snap.m.phase)) { track.stop(); return; }
        track.enabled = this.snap.mic;
        this.local.addTrack(track);
        this.watchTrack(track);
        await Promise.all([...this.peers.values()].map(async (p) => {
          const tr = p.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio');
          if (tr) await tr.sender.replaceTrack(track).catch(() => undefined);
        }));
        this.set({ local: this.local });
      } catch {
        this.set({ mic: false });
        void this.send(this.stateBody(), undefined, false, 1);
      }
      return;
    }
    // The camera: try again, else carry on without video.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(this.snap.facing) });
      const track = s.getVideoTracks()[0]!;
      if (!this.local || !isLive(this.snap.m.phase)) { track.stop(); return; }
      this.local.addTrack(track);
      this.watchTrack(track);
      await this.replaceVideo(track);
      this.set({ local: this.local });
    } catch {
      await this.replaceVideo(null);
      this.set({ cam: false, local: this.local });
      void this.send(this.stateBody(), undefined, false, 1);
    }
  }

  private audioTrack() { return this.local?.getAudioTracks()[0] ?? null; }
  private videoTrack() { return this.local?.getVideoTracks()[0] ?? null; }

  /**
   * ICE servers for this call (normally already cached: prefetched when the chat opened or while ringing).
   * With "Always relay" on, a failed fetch is retried once; if the relay still can't be reached the call
   * fails fast with a clear reason rather than hanging or silently exposing the IP address. A server
   * with no TURN configured at all (relay: false, ok) still connects directly, as documented (§2).
   */
  private async loadIce(): Promise<IceConfig> {
    let ice = await getIceConfig();
    if (!ice.ok && getCallPrefs().relay) ice = await getIceConfig({ fresh: true });
    return ice;
  }

  /** Use these ICE servers; false when relaying is required but impossible. */
  private applyIce(ice: IceConfig): boolean {
    const prefs = getCallPrefs();
    if (prefs.relay && !ice.ok) return false;
    this.ice = ice;
    this.relayOnly = prefs.relay && ice.relay;
    this.set({ relay: !prefs.relay ? 'off' : ice.relay ? 'on' : 'unavailable' });
    return true;
  }

  /** Frame encryption for this call (needs the call key). */
  private setupFrames() {
    const mode = frameMode();
    this.set({ frameMode: mode });
    if (mode && this.callKey && !this.frames) this.frames = new FrameCrypto(mode, this.callKey);
  }

  private joinBody(video: boolean): SignalBody {
    return { k: 'join', fe: !!this.frames, video, ...(trickleOn() ? { tr: true } : {}) };
  }

  /** Data saver for a new call: the setting, or the browser's Save-Data ("Lite mode"). */
  private initialSaver() { return getCallPrefs().saver || !!netInfo()?.saveData; }

  // ------------------------------------------------------------------------------------ place
  /** Call everyone in a conversation (voice or video). */
  async place(summary: ConversationSummary, video: boolean): Promise<void> {
    if (!this.userId || this.snap.m.phase !== 'idle' && this.snap.m.phase !== 'ended') return;
    if (getAppLock().decoy) return;
    this.resetNow();
    const invited = summary.members.filter((m) => m !== this.userId);
    if (!invited.length || summary.members.length > MAX_CALL_PEOPLE) return;
    // The call screen ("Calling…") is up from here, before anything slow happens.
    this.dispatch({ t: 'place', invited });
    this.set({ conv: summary, convId: summary.id, video, isCaller: true, caller: this.userId, masked: false, minimized: false, connectedAt: null, saver: this.initialSaver(), progress: 'calling', mediaError: null, camError: null, sinkId: this.snap.sinkId || getCallDevices().out || '' });
    void nativeCallActive({ speaker: true, video });
    const wantVideo = video && !getCallPrefs().camOff;
    const media = (this.mediaReady = this.getMedia(wantVideo));
    // A permission prompt will be on screen: let the person answer it before anyone's phone rings.
    if (!(await micAllowed()) && !(await media)) { this.dispatch({ t: 'failed', reason: 'no-media' }); return; }
    if (this.phaseNow() !== 'outgoing') return;
    try {
      this.conv = { id: summary.id, audienceId: summary.audience_id, members: summary.members, summary };
      this.callKey = randomBytes(32);
      // Everything else in parallel: the call notice, the conversation key, the call channel and the
      // TURN credentials (usually cached already).
      const ice = this.loadIce();
      const channel = this.joinCallChannel(summary.id);
      const [, key, res] = await Promise.all([people.ensure(summary.members), conversationKey(summary), sb().rpc('start_call', { conv: summary.id, video })]);
      this.convKey = key;
      if (res.error || typeof res.data !== 'string') throw new Error(res.error?.message ?? 'start_call failed');
      if (this.phaseNow() !== 'outgoing') return; // hung up meanwhile
      this.set({ callId: res.data });
      this.setupFrames();
      if (!this.applyIce(await ice)) { this.dispatch({ t: 'failed', reason: 'relay' }); return; }
      if (!(await media)) { this.dispatch({ t: 'failed', reason: 'no-media' }); return; }
      await channel;
      if (this.phaseNow() !== 'outgoing') return;
      startTone('outgoing');
      await Promise.all([this.ringAll(invited, video), this.send(this.joinBody(this.snap.cam), undefined, false, 3)]);
      this.timers.push(setTimeout(() => {
        if (this.snap.m.phase === 'outgoing') { void this.send({ k: 'cancel' }, undefined, false, 2); this.dispatch({ t: 'timeout' }); }
      }, RING_MS));
      this.reRing(video);
    } catch (e) {
      console.warn('call failed to start', e instanceof Error ? e.message : e);
      this.dispatch({ t: 'failed' });
    }
  }

  /** "Try again" after a call that couldn't start or connect. */
  retry() {
    const { conv, video, isCaller, m } = this.snap;
    if (m.phase === 'ended' && conv && isCaller) void this.place(conv, video);
  }

  /** While nobody has answered, ring again every RERING_MS (callees drop duplicates). */
  private reRing(video: boolean) {
    const callId = this.snap.callId;
    const tick = () => {
      if (this.snap.callId !== callId || this.snap.m.phase !== 'outgoing') return;
      const answered = new Set([...this.roster.keys()].map((ep) => parseEndpoint(ep)?.userId));
      const pending = this.snap.m.invited.filter((u) => !this.snap.m.declined.includes(u) && !answered.has(u));
      if (pending.length) void this.ringAll(pending, video);
      this.timers.push(setTimeout(tick, RERING_MS));
    };
    this.timers.push(setTimeout(tick, RERING_MS));
  }

  private async ringAll(userIds: string[], video: boolean) {
    const conv = this.conv;
    if (!conv || !this.convKey || !this.callKey) return;
    const body: SignalBody = { k: 'ring', video, key: b64u.encode(this.callKey) };
    await Promise.all(userIds.map((u) =>
      restBroadcast(`ring:${u}`, this.seal(conv, this.convKey!, this.signal(body), true)).catch(() => undefined)));
  }

  // ------------------------------------------------------------------------------------ incoming
  private async onRing(payload: unknown) {
    const w = payload as { c?: unknown } | null;
    if (!this.userId || !w || typeof w.c !== 'string' || !UUID_RE.test(w.c)) return;
    if (getAppLock().decoy || getSession().status !== 'ready') return;
    const conv = this.conv?.id === w.c ? this.conv : await this.loadConv(w.c);
    if (!conv) return;
    const opened = openSignal(payload, { conv: { id: conv.id, audienceId: conv.audienceId }, keyFor: (e) => keyring.get(conv.audienceId, e), members: this.memberKeys(conv) });
    let res = opened;
    if (!res.ok && res.reason === 'no-key') {
      await keyring.load().catch(() => undefined);
      res = openSignal(payload, { conv: { id: conv.id, audienceId: conv.audienceId }, keyFor: (e) => keyring.get(conv.audienceId, e), members: this.memberKeys(conv) });
    }
    if (!res.ok || res.signal.body.k !== 'ring' || res.author === this.userId) return;
    if (!this.seen.add((payload as { i: string }).i)) return;
    const s = res.signal;
    const body = s.body as Extract<SignalBody, { k: 'ring' }>;
    if (this.ended.has(s.call)) return;
    const phase = this.snap.m.phase;
    if (this.snap.callId === s.call && phase !== 'idle' && phase !== 'ended') return; // a repeat ring
    if (phase !== 'idle' && phase !== 'ended') {
      // Busy: tell the caller (sealed, in their call channel), keep my call.
      const key = await conversationKey(conv.summary).catch(() => null);
      if (key) {
        const busy = sealSignal({ conv: { id: conv.id, audienceId: conv.audienceId }, epoch: key.epoch, key: key.key, signPriv: identity().signPriv, author: this.userId,
          signal: { call: s.call, from: this.myEp(), ts: Date.now(), body: { k: 'busy' } } });
        void restBroadcast(`call:${conv.id}`, busy).catch(() => undefined);
      }
      return;
    }
    this.resetNow();
    this.conv = conv;
    this.convKey = await conversationKey(conv.summary).catch(() => null);
    if (!this.convKey) return;
    try { this.callKey = b64u.decode(body.key); } catch { return; }
    this.dispatch({ t: 'ring', invited: conv.members.filter((m) => m !== this.userId) });
    this.set({
      callId: s.call, convId: conv.id, conv: conv.summary, video: body.video, isCaller: false, caller: res.author,
      masked: isHiddenChat(conv.id) && !isRevealed(), minimized: false, connectedAt: null, saver: this.initialSaver(),
      progress: null, mediaError: null, camError: null, sinkId: this.snap.sinkId || getCallDevices().out || '',
    });
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    startTone('incoming');
    // While it rings: get TURN credentials ready (so accepting doesn't wait for them) and tell the
    // caller this device is ringing ("Ringing…").
    prefetchIceConfig();
    const callId = s.call;
    void this.joinCallChannel(conv.id).then(() => {
      if (this.snap.callId === callId && this.snap.m.phase === 'incoming') void this.send({ k: 'ringing' });
    });
    this.timers.push(setTimeout(() => { if (this.snap.m.phase === 'incoming') this.dispatch({ t: 'timeout' }); }, RING_MS));
  }

  /** Opened from a push ("Dan is calling"): ask whether the call is still ringing. */
  async probe(convId: string, callId: string) {
    if (!this.userId || this.snap.m.phase !== 'idle' && this.snap.m.phase !== 'ended') return;
    if (this.ended.has(callId) || !UUID_RE.test(convId) || !UUID_RE.test(callId)) return;
    const conv = await this.loadConv(convId).catch(() => null);
    if (!conv) return;
    const key = await conversationKey(conv.summary).catch(() => null);
    if (!key) return;
    await this.joinCallChannel(conv.id);
    const wire = this.seal(conv, key, { call: callId, from: this.myEp(), ts: Date.now(), body: { k: 'probe' } });
    if (this.callCh) await this.callCh.send({ type: 'broadcast', event: 'sig', payload: wire }).catch(() => undefined);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.snap.m.phase === 'idle' || this.snap.m.phase === 'ended') this.leaveCallChannel();
    }, 8000);
  }

  async accept() {
    if (this.phaseNow() !== 'incoming' || !this.conv) return;
    stopTone();
    this.dispatch({ t: 'accept' });
    this.set({ progress: 'connecting', mediaError: null, camError: null });
    void nativeCallActive({ speaker: true, video: this.snap.video });
    const wantVideo = this.snap.video && !getCallPrefs().camOff;
    const media = (this.mediaReady = this.getMedia(wantVideo));
    const ice = await this.loadIce(); // fetched while it rang
    if (this.phaseNow() !== 'connecting' || !this.conv) return;
    if (!this.applyIce(ice)) { void this.send({ k: 'decline' }, undefined, true); this.dispatch({ t: 'failed', reason: 'relay' }); return; }
    this.setupFrames();
    await this.joinCallChannel(this.conv.id);
    // Say we're here at once: offers are answered as soon as the microphone is ready (haveMedia).
    await this.send(this.joinBody(wantVideo), undefined, false, 3);
    void sb().rpc('call_answered', { msg: this.snap.callId }).then(() => undefined, () => undefined);
    this.timers.push(setTimeout(() => { if (this.snap.m.phase === 'connecting') this.dispatch({ t: 'timeout' }); }, slowLink() ? CONNECT_SLOW_MS : CONNECT_MS));
    // If our join (or their reply) was dropped, say it again until someone connects.
    const callId = this.snap.callId;
    let tries = 0;
    const again = () => {
      if (this.snap.callId !== callId || this.snap.m.phase !== 'connecting' || this.peers.size > 0 || ++tries > 6) return;
      void this.send(this.joinBody(this.snap.cam));
      this.timers.push(setTimeout(again, JOIN_RETRY_MS));
    };
    this.timers.push(setTimeout(again, JOIN_RETRY_MS));
    if (!(await media) && this.snap.callId === callId && isLive(this.snap.m.phase)) {
      void this.send({ k: 'leave' }, undefined, true);
      this.dispatch({ t: 'failed', reason: 'no-media' });
    }
  }

  decline() {
    if (this.snap.m.phase !== 'incoming') return;
    void this.send({ k: 'decline' }, undefined, true);
    this.dispatch({ t: 'decline' });
  }

  /** Hang up (or decline when ringing). Sent over the REST endpoint with keepalive, so it also works while the page unloads. */
  hangup() {
    const phase = this.snap.m.phase;
    if (phase === 'idle' || phase === 'ended') return;
    if (phase === 'incoming') { void this.send({ k: 'decline' }, undefined, true); this.dispatch({ t: 'decline' }); return; }
    if (phase === 'outgoing' && this.snap.isCaller && !this.snap.m.everConnected) void this.send({ k: 'cancel' }, undefined, true);
    void this.send({ k: 'leave' }, undefined, true);
    this.dispatch({ t: 'hangup' });
  }

  // ------------------------------------------------------------------------------------ signals
  /** Current phase (a method, so TypeScript doesn't narrow it across awaits). */
  private phaseNow(): MachineState['phase'] { return this.snap.m.phase; }
  private inCall() { const p = this.snap.m.phase; return p === 'outgoing' || p === 'connecting' || p === 'active'; }

  private async onSignal(payload: unknown) {
    const conv = this.conv;
    if (!conv || !this.userId) return;
    let res = openSignal(payload, { conv: { id: conv.id, audienceId: conv.audienceId }, keyFor: (e) => keyring.get(conv.audienceId, e), members: this.memberKeys(conv) });
    if (!res.ok && res.reason === 'no-key') {
      await this.keyFor(conv, (payload as { e: number }).e);
      res = openSignal(payload, { conv: { id: conv.id, audienceId: conv.audienceId }, keyFor: (e) => keyring.get(conv.audienceId, e), members: this.memberKeys(conv) });
    }
    if (!res.ok) return;
    if (!this.seen.add((payload as { i: string }).i)) return;
    const s = res.signal;
    const me = this.myEp();
    if (s.from === me || (s.to && s.to !== me)) return;
    if (s.call !== this.snap.callId) return;
    const from = parseEndpoint(s.from)!;
    const b = s.body;
    switch (b.k) {
      case 'join':
        this.roster.set(s.from, { fe: b.fe, video: b.video, tr: !!b.tr });
        if (from.userId !== this.userId && this.snap.isCaller && this.snap.m.phase === 'outgoing') this.set({ progress: 'connecting' });
        if (from.userId === this.userId) {
          if (this.snap.m.phase === 'incoming') this.dispatch({ t: 'answered-elsewhere' });
          return;
        }
        if (!this.inCall()) return;
        // Reply and (if I'm the offerer) start the offer at the same time: the offer doesn't need the
        // reply to have arrived, so waiting for its delivery only added a round trip.
        await Promise.all([
          this.send({ k: 'here', fe: !!this.frames, video: this.snap.cam, ...(trickleOn() ? { tr: true } : {}) }, s.from, false, 2),
          me < s.from ? this.connectTo(s.from) : Promise.resolve(),
        ]);
        return;
      case 'here':
        this.roster.set(s.from, { fe: b.fe, video: b.video, tr: !!b.tr });
        if (this.inCall() && me < s.from) await this.connectTo(s.from);
        return;
      case 'offer':
        if (this.inCall()) await this.onOffer(s.from, b.sdp, b.fe, !!b.tr);
        return;
      case 'cand':
        if (this.inCall()) this.onRemoteCands(s.from, b.u, b.c);
        return;
      case 'ringing':
        if (this.snap.isCaller && this.snap.m.phase === 'outgoing' && this.snap.progress === 'calling') this.set({ progress: 'ringing' });
        return;
      case 'answer': {
        const p = this.peers.get(s.from);
        if (p && p.pc.signalingState === 'have-local-offer') {
          await p.pc.setRemoteDescription({ type: 'answer', sdp: b.sdp }).catch((e) => console.warn('call answer', e));
          if (p.offerTimer) { clearTimeout(p.offerTimer); p.offerTimer = null; }
          void this.applyRemoteCands(p);
          this.reapply(p);
        }
        return;
      }
      case 'state': {
        const p = this.peers.get(s.from);
        if (p) {
          p.mic = b.mic; p.cam = b.cam;
          if (b.vp !== undefined) p.vp = b.vp;
          if (b.net !== undefined) p.net = b.net;
          if (b.rx !== undefined && b.rx !== p.rx) { p.rx = b.rx as Tier; this.reconfigure(p); }
          this.bumpPeers();
        }
        return;
      }
      case 'restart': {
        const p = this.peers.get(s.from);
        if (p?.initiator && Date.now() - p.lastRestartAt > 1_500) this.restartIce(p);
        return;
      }
      case 'reneg': {
        const p = this.peers.get(s.from);
        if (!p?.initiator) return;
        if (b.red !== undefined) p.peerRed = b.red;
        if (p.pc.signalingState === 'stable' && Date.now() - p.lastRenegAt > 3_000) {
          p.lastRenegAt = Date.now();
          const red = !!p.decision?.red || p.peerRed;
          if (red !== p.redNeg) this.setRed(p, red);
          void this.offer(p, false).catch((e) => console.warn('call renegotiate', e));
        }
        return;
      }
      case 'leave':
        this.roster.delete(s.from);
        this.closePeer(s.from);
        return;
      case 'decline':
        if (from.userId === this.userId) { if (this.snap.m.phase === 'incoming') this.dispatch({ t: 'answered-elsewhere' }); return; }
        if (this.snap.isCaller) this.dispatch({ t: 'remote-declined', userId: from.userId });
        return;
      case 'busy':
        if (this.snap.isCaller) this.dispatch({ t: 'remote-declined', userId: from.userId, busy: true });
        return;
      case 'cancel':
        if (from.userId === this.snap.caller) this.dispatch({ t: 'cancelled' });
        return;
      case 'probe':
        // Someone opened the app from a push: ring them again if this call is still going.
        if (this.snap.isCaller && this.inCall() && from.userId !== this.userId && !this.peers.has(s.from)) await this.ringAll([from.userId], this.snap.video);
        return;
      case 'ring':
        return;
    }
  }

  // ------------------------------------------------------------------------------------ peers
  /** What I want to receive: nothing (voice only), the smallest video (data saver), or anything. */
  private rxWanted(): Tier { return this.snap.voiceOnly ? PAUSED : this.snap.saver ? 2 : 0; }

  private ceilingFor(p: { rx: Tier }): Tier {
    return Math.max(meshCeiling(this.peers.size), this.snap.saver ? 2 : 0, p.rx) as Tier;
  }

  private makePeer(ep: string, initiator: boolean, fe: boolean, tr: boolean): Peer {
    const userId = parseEndpoint(ep)!.userId;
    const config: RTCConfiguration & { encodedInsertableStreams?: boolean } = {
      iceServers: this.ice?.iceServers as RTCIceServer[] | undefined,
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      ...(fe && this.frames?.mode === 'streams' ? { encodedInsertableStreams: true } : {}),
    };
    const pc = new RTCPeerConnection(config);
    const rx: Tier = 0;
    const peer: Peer = {
      ep, userId, pc, stream: new MediaStream(), initiator, fe, state: 'connecting', mic: true, cam: !!this.roster.get(ep)?.video, vp: false, net: null, rx,
      ctl: new QualityController({ ceiling: 0, saver: this.snap.saver }, startTier(netInfo(), this.snap.saver)),
      decision: null, applied: { audio: '', video: '' }, sentVp: false,
      relayed: null, safety: null, lostTimer: null, restartTimer: null, restartAttempts: 0, lastRestartAt: 0, offerTimer: null, lastOffer: null, lastAnswer: null,
      prev: { lost: 0, recv: 0, t: 0, aBytes: 0, vBytes: 0, sent: {}, rLost: {} },
      tx: { audioBps: 0, videoBps: 0, height: 0, fps: 0, aob: null, budget: null, rtt: null, loss: 0, limitation: null, red: false },
      uplink: 'good', bytesReceived: 0, paramQueue: Promise.resolve(), redNeg: false, peerRed: false, askedRed: false, ptime: 20, lastRenegAt: Date.now(),
      tr, cands: [], candU: '', candDone: false, candTimer: null, added: new Set(), handling: null,
    };
    pc.onicecandidate = (e) => this.onLocalCandidate(peer, e.candidate);
    pc.ontrack = (e) => {
      if (fe) this.attachTransforms(peer);
      peer.stream.addTrack(e.track);
      this.bumpPeers();
    };
    pc.onconnectionstatechange = () => this.onPeerState(peer);
    this.peers.set(ep, peer);
    this.reconfigureAll();
    this.bumpPeers();
    return peer;
  }

  private transformed = new WeakSet<object>();
  /** Frame encryption on every sender (my key) and receiver (their key) of this peer, once each. */
  private attachTransforms(peer: Peer) {
    if (!peer.fe || !this.frames) return;
    const me = this.myEp();
    for (const t of peer.pc.getTransceivers()) {
      if (!this.transformed.has(t.sender)) { this.transformed.add(t.sender); this.frames.sender(t.sender, me); }
      if (!this.transformed.has(t.receiver)) { this.transformed.add(t.receiver); this.frames.receiver(t.receiver, peer.ep); }
    }
  }

  private codecPrefs(peer: Peer) {
    for (const t of peer.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' || kind === 'video') setCodecPrefs(t, kind, peer.fe, kind === 'audio' && peer.redNeg);
    }
  }

  /** RED on or off for this pair: put it first (or second) in the audio codec order for the next negotiation. */
  private setRed(peer: Peer, red: boolean) {
    peer.redNeg = red;
    const t = peer.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio');
    if (t) setCodecPrefs(t, 'audio', peer.fe, red);
  }

  /**
   * Opus packet time to ask this peer for. 60 ms instead of 20 ms sends a third of the packets: on a
   * 12 kbps voice stream the per-packet costs (IP/UDP/SRTP/RTP headers, TURN framing and the 29-byte
   * frame-encryption trailer) otherwise outweigh the voice itself. Used when either side is saving data
   * or has a poor link, or the controller has squeezed Opus to 12 kbps or less.
   */
  private wantPtime(p: Peer): 20 | 60 {
    const low = this.snap.saver || p.rx >= 2 || this.myNet === 2 || p.net === 2 || verySlowLink() || (!!p.decision && p.decision.audioBitrate <= SAVER_AUDIO);
    return low ? 60 : 20;
  }

  /** The SDP we send: our receive wishes for the other side's Opus encoder (sdp.ts). */
  private outgoingSdp(sdp: string, p: Peer): string {
    const saver = this.snap.saver;
    p.ptime = this.wantPtime(p);
    let out = tuneOpus(sdp, { maxAverageBitrate: saver ? SAVER_AUDIO : 32_000, ptime: p.ptime });
    // Let their video start at a sensible bitrate instead of ~300 kbps (not on slow links / data saver).
    if (!saver && !slowLink() && p.rx < 2) out = videoStartBitrate(out, VIDEO_START_KBPS);
    if (debugOn()) {
      try {
        const cap = Number(localStorage.getItem('kw.calls.testVideoCapKbps'));
        if (cap > 0) out = capVideoBandwidth(out, cap);
      } catch { /* ignore */ }
    }
    return out;
  }

  private async connectTo(ep: string) {
    if (this.peers.has(ep) || !(await this.haveMedia())) return;
    if (this.peers.has(ep) || !this.local || !this.inCall()) return;
    const fe = !!this.frames && !!this.roster.get(ep)?.fe;
    const peer = this.makePeer(ep, true, fe, trickleOn() && !!this.roster.get(ep)?.tr);
    const pc = peer.pc;
    pc.addTransceiver(this.audioTrack() ?? 'audio', { direction: 'sendrecv', streams: [this.local] });
    pc.addTransceiver(this.videoTrack() ?? 'video', { direction: 'sendrecv', streams: [this.local] });
    this.attachTransforms(peer);
    this.codecPrefs(peer);
    await this.offer(peer, false);
  }

  private async offer(peer: Peer, iceRestart: boolean) {
    const pc = peer.pc;
    if (iceRestart) { peer.lastRestartAt = Date.now(); this.restarts++; }
    await pc.setLocalDescription(await pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
    // Trickle: send the offer now, candidates follow. Older peers: wait for gathering (vanilla ICE).
    if (!peer.tr) await waitForIce(pc);
    if (pc.connectionState === 'closed' || !pc.localDescription) return;
    const sdp = this.outgoingSdp(pc.localDescription.sdp, peer);
    const local = pc.localDescription.sdp;
    const body: SignalBody = { k: 'offer', sdp, fe: peer.fe, ...(peer.tr ? { tr: true } : {}) };
    await this.send(body, peer.ep, false, 3);
    if (peer.tr) this.flushCands(peer, 0);
    // No answer in time (a dropped message): send the same offer again. The answerer recognises it and
    // repeats its answer rather than renegotiating.
    if (peer.offerTimer) clearTimeout(peer.offerTimer);
    let tries = 0;
    const check = () => {
      peer.offerTimer = null;
      if (!this.peers.has(peer.ep) || pc.signalingState !== 'have-local-offer' || pc.localDescription?.sdp !== local || ++tries > OFFER_TRIES) return;
      void this.send(body, peer.ep, false, 1);
      if (peer.tr) this.flushCands(peer, 0);
      peer.offerTimer = setTimeout(check, OFFER_RETRY_MS * 1.5 ** tries);
    };
    peer.offerTimer = setTimeout(check, OFFER_RETRY_MS);
  }

  private async onOffer(ep: string, sdp: string, theirFe: boolean, theirTr: boolean) {
    let peer = this.peers.get(ep);
    // The same offer again (their retry after our answer was lost): repeat the answer, don't renegotiate.
    if (peer && peer.lastOffer === sdp && peer.lastAnswer) {
      await this.send({ k: 'answer', sdp: peer.lastAnswer, fe: peer.fe, ...(peer.tr ? { tr: true } : {}) }, ep, false, 2);
      if (peer.tr) this.flushCands(peer, 0);
      return;
    }
    if (peer?.handling === sdp) return; // a repeat while we're still answering it
    // The microphone first (it may still be starting, or waiting for a permission prompt).
    if (!peer && !(await this.haveMedia())) return;
    peer = this.peers.get(ep);
    if (peer?.handling === sdp || !this.inCall()) return;
    const fresh = !peer;
    const tr = theirTr && trickleOn();
    if (!peer) peer = this.makePeer(ep, false, theirFe && !!this.frames, tr);
    else peer.tr = tr;
    const p = peer;
    p.handling = sdp;
    const pc = p.pc;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      void this.applyRemoteCands(p);
      if (fresh && this.local) {
        this.attachTransforms(p);
        for (const t of pc.getTransceivers()) {
          const kind = t.receiver.track.kind;
          t.direction = 'sendrecv';
          await t.sender.replaceTrack(kind === 'audio' ? this.audioTrack() : this.videoTrack());
          try { t.sender.setStreams?.(this.local); } catch { /* older browsers */ }
        }
        this.codecPrefs(p);
      }
      // RED is a property of the pair: the offerer decides (it hears our wish via `reneg`), we mirror it.
      const red = firstAudioCodec(sdp) === 'red';
      if (red !== p.redNeg) this.setRed(p, red);
      await pc.setLocalDescription(await pc.createAnswer());
      if (!fresh) this.reapply(p);
      if (!p.tr) await waitForIce(pc);
      if (pc.connectionState === 'closed' || !pc.localDescription) return;
      const answer = this.outgoingSdp(pc.localDescription.sdp, p);
      p.lastOffer = sdp;
      p.lastAnswer = answer;
      await this.send({ k: 'answer', sdp: answer, fe: p.fe, ...(p.tr ? { tr: true } : {}) }, ep, false, 3);
      if (p.tr) this.flushCands(p, 0);
    } finally {
      if (p.handling === sdp) p.handling = null;
    }
  }

  // ------------------------------------------------------------------------------------ trickle ICE
  /**
   * A local candidate: keep it in this generation's cumulative list and send the list (the first one at
   * once, later ones batched). Every `cand` message carries ALL candidates so far, so it supersedes the
   * earlier ones: a lost message costs nothing, a repeated one is a no-op (docs §3, §12).
   */
  private onLocalCandidate(peer: Peer, c: RTCIceCandidate | null) {
    if (!peer.tr) return;
    if (!c || !c.candidate) { if (peer.candU) { peer.candDone = true; this.flushCands(peer, 0); } return; }
    const u = c.usernameFragment || ufragOf(peer.pc.localDescription?.sdp);
    if (!u) return;
    if (u !== peer.candU) { peer.candU = u; peer.cands = []; peer.candDone = false; }
    if (peer.cands.some((x) => x[2] === c.candidate)) return;
    peer.cands.push([c.sdpMid ?? '0', c.sdpMLineIndex ?? 0, c.candidate]);
    this.flushCands(peer, peer.cands.length === 1 ? 0 : CAND_BATCH_MS);
  }

  private flushCands(peer: Peer, delay: number) {
    if (!peer.tr || !peer.candU || !peer.cands.length) return;
    if (peer.candTimer) { if (delay > 0) return; clearTimeout(peer.candTimer); }
    peer.candTimer = setTimeout(() => {
      peer.candTimer = null;
      if (!this.peers.has(peer.ep)) return;
      void this.send({ k: 'cand', u: peer.candU, c: peer.cands.slice(0, 64), ...(peer.candDone ? { done: true } : {}) }, peer.ep, false, 1);
    }, delay);
  }

  /** Their candidates (cumulative for one ICE generation): keep them until the matching description is set. */
  private onRemoteCands(ep: string, u: string, list: Cand[]) {
    const prev = this.earlyCands.get(ep);
    const c = prev && prev.u === u ? [...prev.c, ...list.filter((x) => !prev.c.some((y) => y[2] === x[2]))] : list;
    this.earlyCands.set(ep, { u, c });
    const p = this.peers.get(ep);
    if (p) void this.applyRemoteCands(p);
  }

  private async applyRemoteCands(p: Peer) {
    const e = this.earlyCands.get(p.ep);
    if (!e || ufragOf(p.pc.remoteDescription?.sdp) !== e.u) return;
    for (const [sdpMid, sdpMLineIndex, candidate] of e.c) {
      const key = `${e.u} ${candidate}`;
      if (p.added.has(key)) continue;
      p.added.add(key);
      await p.pc.addIceCandidate({ candidate, sdpMid, sdpMLineIndex, usernameFragment: e.u }).catch(() => undefined);
    }
  }

  private onPeerState(peer: Peer) {
    const st = peer.pc.connectionState;
    if (st === 'connected') {
      if (peer.lostTimer) { clearTimeout(peer.lostTimer); peer.lostTimer = null; }
      if (peer.restartTimer) { clearTimeout(peer.restartTimer); peer.restartTimer = null; }
      peer.restartAttempts = 0;
      const first = !peer.decision;
      peer.state = 'connected';
      this.bumpPeers();
      this.dispatch({ t: 'peer-connected', count: this.connectedCount() });
      if (!peer.safety) void this.computeSafety(peer);
      this.startStats();
      void this.send(this.stateBody({ vp: peer.sentVp }), peer.ep, false, 2);
      if (first) void this.applyDecision(peer, peer.ctl.configure({}));
    } else if (st === 'disconnected' || st === 'failed') {
      peer.state = 'reconnecting';
      this.bumpPeers();
      // 'disconnected' often heals on its own; 'failed' won't. Either way, keep the call on screen
      // ("Reconnecting…") and restart ICE with back-off until RECONNECT_MS runs out.
      this.scheduleRestart(peer, st === 'failed' ? 0 : DISCONNECT_GRACE_MS);
      peer.lostTimer ??= setTimeout(() => { if (peer.pc.connectionState !== 'connected') this.closePeer(peer.ep); }, RECONNECT_MS);
    } else if (st === 'closed') {
      this.closePeer(peer.ep);
    }
  }

  private scheduleRestart(peer: Peer, delay: number) {
    if (peer.restartTimer) return;
    peer.restartTimer = setTimeout(() => {
      peer.restartTimer = null;
      if (!this.peers.has(peer.ep) || peer.pc.connectionState === 'connected' || peer.pc.connectionState === 'closed') { peer.restartAttempts = 0; return; }
      this.restartIce(peer);
      peer.restartAttempts++;
      this.scheduleRestart(peer, Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** peer.restartAttempts));
    }, delay);
  }

  /** ICE restart: the offerer re-offers with new credentials; the answerer asks the offerer to. Both sealed. */
  private restartIce(peer: Peer) {
    if (peer.initiator) {
      void this.offer(peer, true).catch((e) => console.warn('call ice restart', e));
    } else {
      peer.lastRestartAt = Date.now();
      void this.send({ k: 'restart' }, peer.ep, false, 2);
    }
  }

  /** online / connection 'change': restart ICE on every peer now (debounced). */
  private onNetworkChange(now = false) {
    if (this.netTimer) clearTimeout(this.netTimer);
    const run = () => {
      this.netTimer = null;
      if (!this.inCall()) return;
      for (const p of this.peers.values()) {
        if (Date.now() - p.lastRestartAt < 1_500) continue;
        p.restartAttempts = 0;
        if (p.restartTimer) { clearTimeout(p.restartTimer); p.restartTimer = null; }
        this.restartIce(p);
      }
      this.refreshWeak();
    };
    if (now) run(); else this.netTimer = setTimeout(run, 1_000);
  }

  private connectedCount() { return [...this.peers.values()].filter((p) => p.state === 'connected').length; }

  private clearPeerTimers(p: Peer) {
    if (p.lostTimer) clearTimeout(p.lostTimer);
    if (p.restartTimer) clearTimeout(p.restartTimer);
    if (p.offerTimer) clearTimeout(p.offerTimer);
    if (p.candTimer) clearTimeout(p.candTimer);
    p.lostTimer = p.restartTimer = p.offerTimer = p.candTimer = null;
  }

  private closePeer(ep: string) {
    const p = this.peers.get(ep);
    if (!p) return;
    this.peers.delete(ep);
    this.earlyCands.delete(ep);
    this.clearPeerTimers(p);
    try { p.pc.close(); } catch { /* already closed */ }
    p.stream.getTracks().forEach((t) => t.stop());
    this.reconfigureAll();
    this.bumpPeers();
    this.dispatch({ t: 'peer-left', count: this.peers.size });
  }

  private async computeSafety(peer: Peer) {
    const mine = sdpFingerprint(peer.pc.localDescription?.sdp);
    const theirs = sdpFingerprint(peer.pc.remoteDescription?.sdp);
    const a = people.get(this.userId!);
    const b = people.get(peer.userId);
    if (!mine || !theirs || !b || !this.snap.callId) return;
    const myPub = a?.sign_pub ?? b64u.encode(identity().signPub);
    peer.safety = await callSafetyCode(this.snap.callId, { userId: this.userId!, signPub: myPub, fingerprint: mine }, { userId: peer.userId, signPub: b.sign_pub, fingerprint: theirs });
    this.bumpPeers();
  }

  // ------------------------------------------------------------------------------- quality control
  private stateBody(extra: { vp?: boolean } = {}): SignalBody {
    return { k: 'state', mic: this.snap.mic, cam: this.snap.cam, net: this.myNet, rx: this.rxWanted() as 0 | 1 | 2 | 3, ...extra };
  }

  private reconfigure(p: Peer) {
    const d = p.ctl.configure({ ceiling: this.ceilingFor(p), saver: this.snap.saver || p.rx >= 2 });
    if (p.state === 'connected') void this.applyDecision(p, d);
  }
  private reconfigureAll() { for (const p of this.peers.values()) this.reconfigure(p); }

  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => { void this.pollStats(); }, STATS_MS);
  }

  /** After a renegotiation, push the current decision to the senders again. */
  private reapply(p: Peer) {
    p.applied = { audio: '', video: '' };
    if (p.decision && p.state === 'connected') void this.applyDecision(p, p.decision);
  }

  /**
   * Renegotiate (no ICE restart) when the Opus packet time this peer should use changed, or RED should go
   * on/off. RED needs a renegotiation: Chrome sends RED only when it is first in the negotiated audio
   * codec order (setParameters' per-encoding `codec` is accepted for audio but changes nothing). The
   * offerer decides for the pair (RED if either side's controller wants it); the answerer asks with
   * `reneg`. Rate-limited to one every 10 s per peer, on top of the controller's own hysteresis.
   */
  private maybeRenegotiate(p: Peer) {
    if (p.state !== 'connected' || Date.now() - p.lastRenegAt < 10_000) return;
    const ptime = this.wantPtime(p) !== p.ptime;
    const mine = !!p.decision?.red;
    if (p.initiator) {
      const red = mine || p.peerRed;
      if ((!ptime && red === p.redNeg) || p.pc.signalingState !== 'stable') return;
      p.lastRenegAt = Date.now();
      if (red !== p.redNeg) this.setRed(p, red);
      void this.offer(p, false).catch((e) => console.warn('call renegotiate', e));
    } else {
      if (!ptime && mine === p.askedRed) return;
      p.lastRenegAt = Date.now();
      p.askedRed = mine;
      void this.send({ k: 'reneg', red: mine }, p.ep, false, 1);
    }
  }

  private async pollStats() {
    const list = [...this.peers.values()];
    const samples: (NetSample | null)[] = [];
    const now = performance.now();
    for (const p of list) {
      try {
        const report = await p.pc.getStats();
        let pairId: string | null = null;
        let rtt: number | null = null;
        let aob: number | null = null;
        let lost = 0, recv = 0, bytes = 0, aBytes = 0, vBytes = 0, height = 0, fps = 0, jitter: number | null = null;
        // Outbound loss per kind from cumulative counters (packets they report lost / packets I sent since the
        // last sample). remote-inbound-rtp's fractionLost is only refreshed when a new receiver report arrives,
        // so a paused video stream kept its last (often high) value for the rest of the call and pinned the
        // controller in "voice only" on perfectly good links.
        const sent: Record<string, number> = {};
        const rLost: Record<string, number> = {};
        let limitation: Limitation | null = null;
        report.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
          if (s.type === 'inbound-rtp') {
            lost += s.packetsLost ?? 0; recv += s.packetsReceived ?? 0; bytes += s.bytesReceived ?? 0;
            if (s.kind === 'audio' && typeof s.jitter === 'number') jitter = s.jitter;
          }
          if (s.type === 'outbound-rtp') {
            sent[s.kind] = (sent[s.kind] ?? 0) + (s.packetsSent ?? 0);
            if (s.kind === 'audio') aBytes += s.bytesSent ?? 0;
            else {
              vBytes += s.bytesSent ?? 0;
              if (typeof s.frameHeight === 'number') height = s.frameHeight;
              if (typeof s.framesPerSecond === 'number') fps = s.framesPerSecond;
              if (typeof s.qualityLimitationReason === 'string') limitation = s.qualityLimitationReason as Limitation;
            }
          }
          if (s.type === 'remote-inbound-rtp') {
            rLost[s.kind] = (rLost[s.kind] ?? 0) + Math.max(0, s.packetsLost ?? 0);
            if (rtt === null && typeof s.roundTripTime === 'number') rtt = s.roundTripTime;
          }
        });
        if (!pairId) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id; });
        const pair = pairId ? report.get(pairId) : null;
        if (pair) {
          if (typeof pair.currentRoundTripTime === 'number') rtt = pair.currentRoundTripTime;
          if (typeof pair.availableOutgoingBitrate === 'number') aob = pair.availableOutgoingBitrate;
          const lc = report.get(pair.localCandidateId);
          const rc = report.get(pair.remoteCandidateId);
          p.relayed = lc?.candidateType === 'relay' || rc?.candidateType === 'relay';
        }
        const outLoss = deltaLoss(sent, rLost, p.prev.sent, p.prev.rLost);
        const dl = lost - p.prev.lost;
        const dr = recv - p.prev.recv;
        const dt = p.prev.t ? (now - p.prev.t) / 1000 : 0;
        const bps = (cur: number, prev: number) => (dt > 0 && cur >= prev ? Math.round(((cur - prev) * 8) / dt) : 0);
        p.tx = { ...p.tx, audioBps: bps(aBytes, p.prev.aBytes), videoBps: bps(vBytes, p.prev.vBytes), height, fps, aob, rtt, loss: outLoss, limitation, red: p.redNeg && p.pc.signalingState === 'stable' };
        p.prev = { lost, recv, t: now, aBytes, vBytes, sent, rLost };
        p.bytesReceived = bytes;
        const inLoss = dr + dl > 0 ? Math.max(0, dl) / (dr + Math.max(0, dl)) : 0;
        if (p.state !== 'connected') { samples.push(null); continue; }
        samples.push({ availableOut: aob, rtt, loss: outLoss, inLoss, jitter, limitation, ...(debugOn() ? this.netOverride ?? {} : {}) });
      } catch { samples.push(null); /* closed meanwhile */ }
    }
    // Mesh: every connection shares one uplink.
    const shared = shareUplink(samples.map((s) => (s ? s.availableOut : null)));
    list.forEach((p, i) => {
      const s = samples[i];
      if (!s) return;
      p.tx.budget = shared[i] ?? null;
      const d = p.ctl.update({ ...s, availableOut: p.tx.budget });
      p.uplink = s.loss >= 0.10 || (s.availableOut !== null && s.availableOut < 100_000) ? 'poor'
        : s.loss >= 0.03 || (s.availableOut !== null && s.availableOut < 250_000) ? 'fair' : 'good';
      void this.applyDecision(p, d);
    });
    this.refreshWeak();
    for (const p of list) this.maybeRenegotiate(p);
    this.set({ peers: this.peerViews(), frameStats: this.frames ? this.frames.stats() : null });
  }

  /** Apply a controller decision to this peer's senders (only what changed), one setParameters at a time. */
  private applyDecision(p: Peer, d: Decision): Promise<void> {
    p.decision = d;
    const job = async () => {
      if (p.pc.connectionState === 'closed') return;
      const audio = p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio')?.sender;
      const video = p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
      const aKey = `${d.audioBitrate}`;
      if (audio && p.applied.audio !== aKey) {
        const params = audio.getParameters();
        const enc = params.encodings?.[0];
        if (enc) {
          enc.maxBitrate = d.audioBitrate;
          enc.priority = 'high';
          enc.networkPriority = 'high';
          await audio.setParameters(params).catch(() => undefined);
          p.applied.audio = aKey;
        }
      }
      if (video) {
        const height = this.videoTrack()?.getSettings().height ?? 0;
        const v = videoEncoding(d.tier, height, p.tx.budget);
        const vKey = `${v.active}|${v.scaleResolutionDownBy}|${Math.round(v.maxBitrate / 50_000)}|${v.maxFramerate}`;
        if (p.applied.video !== vKey) {
          const params = video.getParameters();
          const enc = params.encodings?.[0];
          if (enc) {
            enc.active = v.active;
            enc.scaleResolutionDownBy = v.scaleResolutionDownBy;
            enc.maxBitrate = v.maxBitrate;
            enc.maxFramerate = v.maxFramerate;
            enc.priority = 'low';
            enc.networkPriority = 'low';
            // Smooth motion while there is room; at 180p, trade a bit of both instead.
            params.degradationPreference = d.tier <= 1 ? 'maintain-framerate' : 'balanced';
            try { await video.setParameters(params); } catch {
              const again = video.getParameters();
              const e2 = again.encodings?.[0];
              if (e2) Object.assign(e2, { active: v.active, scaleResolutionDownBy: v.scaleResolutionDownBy, maxBitrate: v.maxBitrate, maxFramerate: v.maxFramerate });
              await video.setParameters(again).catch(() => undefined);
            }
            p.applied.video = vKey;
          }
        }
      }
      // Tell them when my video to them is paused by the network (they show my avatar, not a frozen frame).
      const vp = d.tier === PAUSED && this.snap.cam && p.rx < PAUSED;
      if (vp !== p.sentVp) { p.sentVp = vp; void this.send(this.stateBody({ vp }), p.ep, false, 1); }
    };
    p.paramQueue = p.paramQueue.then(job, job).catch(() => undefined);
    return p.paramQueue;
  }

  /** Whose connection is weak, and whether to suggest voice only. */
  private refreshWeak() {
    const list = [...this.peers.values()].filter((p) => p.state === 'connected' || p.state === 'reconnecting');
    const et = netInfo()?.effectiveType;
    // Mine: offline, a 2G link, or every connection's uplink looks bad (with one peer, only a low
    // bandwidth estimate counts: loss alone could be at either end).
    const upPoor = list.filter((p) => p.uplink === 'poor');
    const bwPoor = list.filter((p) => p.tx.budget !== null && p.tx.budget < 100_000);
    let raw: 0 | 1 | 2 = 0;
    if (this.offline || et === 'slow-2g' || et === '2g') raw = 2;
    else if (list.length && (bwPoor.length === list.length || (list.length >= 2 && upPoor.length === list.length))) raw = 2;
    else if (list.length && list.every((p) => p.uplink !== 'good')) raw = 1;
    if (raw === this.myNet) this.myNetCand = raw;
    else if (raw === this.myNetCand || (raw === 2 && this.offline)) this.myNet = raw;
    else this.myNetCand = raw;
    if (this.myNet !== this.sentNet && this.snap.m.phase === 'active') { this.sentNet = this.myNet; void this.send(this.stateBody()); }

    let weak: Weak = null;
    if (this.myNet === 2) weak = { who: 'me' };
    else {
      const them = list.find((p) => p.net === 2 || (p.vp && p.decision?.quality === 'poor'));
      if (them) weak = { who: 'peer', userId: them.userId };
      else if (list.some((p) => p.decision?.quality === 'poor' || p.state === 'reconnecting')) weak = { who: 'link' };
    }
    const videoInvolved = this.snap.cam || list.some((p) => p.cam && !p.vp);
    const pausedByNet = list.some((p) => p.decision?.tier === PAUSED && p.decision.constrained && this.snap.cam);
    this.weakPolls = (weak && weak.who !== 'link') || pausedByNet ? this.weakPolls + 1 : weak ? this.weakPolls : 0;
    const suggestVoice = !this.suggestDismissed && !this.snap.voiceOnly && videoInvolved && this.weakPolls >= 3;
    const same = JSON.stringify(weak) === JSON.stringify(this.snap.weak);
    if (!same || suggestVoice !== this.snap.suggestVoice) this.set({ weak, suggestVoice });
  }

  // ------------------------------------------------------------------------------------ controls
  toggleMic() {
    const t = this.audioTrack();
    if (!t) return;
    t.enabled = !t.enabled;
    this.set({ mic: t.enabled });
    void this.send(this.stateBody(), undefined, false, 1);
  }

  async toggleCam() {
    if (!this.local) return;
    const cur = this.videoTrack();
    if (cur) {
      cur.stop();
      this.local.removeTrack(cur);
      await this.replaceVideo(null);
      this.set({ cam: false, local: this.local });
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(this.snap.facing) });
        const track = s.getVideoTracks()[0]!;
        this.local.addTrack(track);
        await this.replaceVideo(track);
        // Turning the camera back on ends voice-only: I'd like to see them again too.
        this.set({ cam: true, local: this.local, voiceOnly: false });
        this.reconfigureAll();
      } catch { return; }
    }
    void this.send(this.stateBody(), undefined, false, 1);
  }

  async switchCamera() {
    const cur = this.videoTrack();
    if (!this.local || !cur) return;
    const facing = this.snap.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints({ exact: facing }) });
      const track = s.getVideoTracks()[0]!;
      cur.stop();
      this.local.removeTrack(cur);
      this.local.addTrack(track);
      await this.replaceVideo(track);
      this.set({ facing, local: this.local });
    } catch { /* only one camera */ }
  }

  private async replaceVideo(track: MediaStreamTrack | null) {
    await Promise.all([...this.peers.values()].map(async (p) => {
      const t = p.pc.getTransceivers().find((x) => x.receiver.track.kind === 'video');
      if (t) await t.sender.replaceTrack(track).catch(() => undefined);
      p.applied.video = ''; // capture size may differ: re-apply the tier
      if (p.decision) void this.applyDecision(p, p.decision);
    }));
  }

  /** In-call data saver: smallest video both ways, Opus ≤ 12 kbps. */
  setSaver(on: boolean) {
    if (on === this.snap.saver) return;
    this.set({ saver: on });
    this.reconfigureAll();
    void this.send(this.stateBody(), undefined, false, 1);
  }

  /** "Switch to voice": my camera off, and ask the others to stop sending video (saves both directions). */
  async voiceOnly() {
    if (this.videoTrack()) await this.toggleCam();
    this.set({ voiceOnly: true, suggestVoice: false });
    this.suggestDismissed = true;
    void this.send(this.stateBody(), undefined, false, 1);
  }

  dismissSuggestion() { this.suggestDismissed = true; this.set({ suggestVoice: false }); }

  setMinimized(v: boolean) { this.set({ minimized: v }); }
  setSink(id: string) { this.set({ sinkId: id }); }

  // ------------------------------------------------------------------------------------ teardown
  /** The call ended (any reason): release everything, show "Call ended" briefly, then go idle. */
  private finish() {
    const wasConnected = this.snap.m.everConnected;
    void nativeCallEnded();
    stopTone();
    if (wasConnected || this.snap.m.reason !== 'elsewhere') endTone();
    if (this.snap.callId) this.ended.add(this.snap.callId);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (this.netTimer) clearTimeout(this.netTimer);
    this.netTimer = null;
    for (const ep of [...this.peers.keys()]) {
      const p = this.peers.get(ep)!;
      this.clearPeerTimers(p);
      try { p.pc.close(); } catch { /* ignore */ }
      p.stream.getTracks().forEach((t) => t.stop());
    }
    this.peers.clear();
    this.roster.clear();
    this.earlyCands.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.mediaReady = null;
    this.mediaGen++;
    this.frames?.close();
    this.frames = null;
    this.callKey = null;
    this.leaveCallChannel();
    this.myNet = this.myNetCand = this.sentNet = 0;
    this.weakPolls = 0;
    this.suggestDismissed = false;
    this.set({ local: null, peers: [], minimized: false, weak: null, suggestVoice: false });
    if (this.resetTimer) clearTimeout(this.resetTimer);
    const r = this.snap.m.reason;
    this.resetTimer = setTimeout(() => this.resetNow(), r === 'failed' || r === 'no-media' || r === 'relay' ? ENDED_ERROR_MS : ENDED_SHOW_MS);
  }

  private resetNow() {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (isLive(this.snap.m.phase) || this.snap.m.phase === 'incoming') return;
    this.conv = null;
    this.convKey = null;
    this.restarts = 0;
    this.snap = { ...EMPTY, relay: this.snap.relay, sinkId: this.snap.sinkId };
    this.listeners.forEach((l) => l());
  }

  dismiss() { if (this.snap.m.phase === 'ended') this.resetNow(); }
}

export const calls = new CallEngine();

export function useCall(): CallSnapshot {
  return useSyncExternalStore(calls.subscribe, calls.get, () => EMPTY);
}
