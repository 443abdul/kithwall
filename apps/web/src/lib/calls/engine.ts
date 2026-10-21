'use client';
// The call engine (docs/v2/04-calls.md). One instance per tab; React reads it through useCall().
//
//  - Ringing: the caller writes a call notice (start_call RPC → push for offline people, missed-call
//    line in the thread) and sends a sealed `ring` to each callee's private `ring:<user id>` topic.
//  - Signalling: everyone in the call joins the private `call:<conversation id>` topic. Every message is
//    a sealed + signed envelope (signal.ts). Realtime only relays opaque blobs.
//  - Media: a full mesh of RTCPeerConnections (≤ 8 people). The lower endpoint id makes the offer, so
//    there is never glare. ICE is gathered before the offer/answer is sent ("vanilla" ICE: fewer
//    signalling messages, nothing to reorder). DTLS fingerprints travel inside the signed SDP, so the
//    DTLS-SRTP keys are authenticated end to end; TURN relays only see ciphertext.
//  - Frame encryption (insertable streams) is added where both ends support it (e2ee.ts).
import { b64u, randomBytes } from '@kithwall/crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { sb, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../supabase';
import { getSession, identity, onLock } from '../keys/session';
import { keyring } from '../keys/keyring';
import { people } from '../people';
import { conversationKey, getConversation, type ConversationSummary } from '../messages';
import { isHiddenChat, isRevealed } from '../safety/hidden';
import { getAppLock } from '../safety/applock';
import { getCallPrefs, loadCallPrefs } from './prefs';
import { IDLE, isLive, step, type MachineEvent, type MachineState } from './machine';
import { endpointOf, openSignal, parseEndpoint, sealSignal, SeenIds, UUID_RE, type Signal, type SignalBody } from './signal';
import { FrameCrypto, frameMode, preferVp8, type FrameMode, type FrameStats } from './e2ee';
import { callSafetyCode, sdpFingerprint, type SafetyCode } from './safety';
import { endTone, startTone, stopTone } from './tones';
import { getIceConfig, type IceConfig } from './turn';

export const MAX_CALL_PEOPLE = 8;
const RING_MS = 45_000;
const CONNECT_MS = 30_000;
const ICE_GATHER_MS = 3_000;
const RECONNECT_MS = 15_000;
const ENDED_SHOW_MS = 2_500;

export type PeerState = 'connecting' | 'connected' | 'reconnecting';
export type Quality = 'good' | 'fair' | 'poor';

export interface PeerView {
  ep: string;
  userId: string;
  stream: MediaStream;
  state: PeerState;
  mic: boolean;
  cam: boolean;
  quality: Quality | null;
  relayed: boolean | null;
  safety: SafetyCode | null;
  frames: boolean;
  bytesReceived: number;
}

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
}

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
  quality: Quality | null;
  relayed: boolean | null;
  safety: SafetyCode | null;
  restarted: boolean;
  lostTimer: ReturnType<typeof setTimeout> | null;
  prev: { lost: number; recv: number };
  bytesReceived: number;
}

interface ConvCtx { id: string; audienceId: string; members: string[]; summary: ConversationSummary }

const EMPTY: CallSnapshot = {
  m: IDLE, callId: null, convId: null, conv: null, isCaller: false, caller: null, video: false, masked: false,
  connectedAt: null, local: null, mic: true, cam: false, facing: 'user', peers: [], minimized: false,
  frameMode: null, frameStats: null, relay: 'on', sinkId: '',
};

const DEV_ID = typeof window === 'undefined' ? 'server' : b64u.encode(randomBytes(9));

async function restBroadcast(topic: string, payload: unknown, keepalive = false): Promise<void> {
  const token = (await sb().auth.getSession()).data.session?.access_token;
  if (!token) return;
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST', keepalive, credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic, event: 'sig', payload, private: true }] }),
  });
  await res.body?.cancel().catch(() => undefined);
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(t); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ICE_GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
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
  private roster = new Map<string, { fe: boolean; video: boolean }>();
  private seen = new SeenIds();
  private ended = new Set<string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private local: MediaStream | null = null;
  private cleanup: (() => void)[] = [];
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
      ep: p.ep, userId: p.userId, stream: p.stream, state: p.state, mic: p.mic, cam: p.cam, quality: p.quality,
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
    this.cleanup.push(() => window.removeEventListener('pagehide', hide), offLock);
    if (typeof localStorage !== 'undefined' && localStorage.getItem('kw.calls.debug') === '1') {
      (window as unknown as { __kwCall?: unknown }).__kwCall = { engine: this, pcs: () => [...this.peers.values()].map((p) => p.pc) };
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

  /** Send to everyone in the call channel (or to one endpoint, still over the channel). */
  private async send(body: SignalBody, to?: string, keepalive = false) {
    const conv = this.conv;
    const key = this.convKey;
    if (!conv || !key || !this.snap.callId || !this.userId) return;
    const wire = this.seal(conv, key, this.signal(body, to));
    const ch = this.callCh;
    if (!keepalive && ch && this.callChConv === conv.id && (ch as unknown as { state?: string }).state === 'joined') {
      const r = await ch.send({ type: 'broadcast', event: 'sig', payload: wire });
      if (r === 'ok') return;
    }
    await restBroadcast(`call:${conv.id}`, wire, keepalive).catch(() => undefined);
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
  private async getMedia(video: boolean): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    this.local = stream;
    this.set({ local: stream, mic: true, cam: video, facing: 'user' });
    return stream;
  }

  private audioTrack() { return this.local?.getAudioTracks()[0] ?? null; }
  private videoTrack() { return this.local?.getVideoTracks()[0] ?? null; }

  private async prepareTransport() {
    const prefs = getCallPrefs();
    this.ice = await getIceConfig();
    this.relayOnly = prefs.relay && this.ice.relay;
    const mode = frameMode();
    this.set({ relay: !prefs.relay ? 'off' : this.ice.relay ? 'on' : 'unavailable', frameMode: mode });
    if (mode && this.callKey) this.frames = new FrameCrypto(mode, this.callKey);
  }

  // ------------------------------------------------------------------------------------ place
  /** Call everyone in a conversation (voice or video). */
  async place(summary: ConversationSummary, video: boolean): Promise<void> {
    if (!this.userId || this.snap.m.phase !== 'idle' && this.snap.m.phase !== 'ended') return;
    if (getAppLock().decoy) return;
    this.resetNow();
    const invited = summary.members.filter((m) => m !== this.userId);
    if (!invited.length || summary.members.length > MAX_CALL_PEOPLE) return;
    this.dispatch({ t: 'place', invited });
    this.set({ conv: summary, convId: summary.id, video, isCaller: true, caller: this.userId, masked: false, minimized: false, connectedAt: null });
    try {
      await this.getMedia(video);
    } catch {
      this.dispatch({ t: 'failed', reason: 'no-media' });
      return;
    }
    try {
      await people.ensure(summary.members);
      this.conv = { id: summary.id, audienceId: summary.audience_id, members: summary.members, summary };
      this.convKey = await conversationKey(summary);
      const res = await sb().rpc('start_call', { conv: summary.id, video });
      if (res.error || typeof res.data !== 'string') throw new Error(res.error?.message ?? 'start_call failed');
      if (this.phaseNow() !== 'outgoing') return; // hung up meanwhile
      this.callKey = randomBytes(32);
      this.set({ callId: res.data });
      await this.prepareTransport();
      await this.joinCallChannel(summary.id);
      await this.send({ k: 'join', fe: !!this.frames, video });
      startTone('outgoing');
      await this.ringAll(invited, video);
      this.timers.push(setTimeout(() => {
        if (this.snap.m.phase === 'outgoing') { void this.send({ k: 'cancel' }); this.dispatch({ t: 'timeout' }); }
      }, RING_MS));
    } catch (e) {
      console.warn('call failed to start', e instanceof Error ? e.message : e);
      this.dispatch({ t: 'failed' });
    }
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
      masked: isHiddenChat(conv.id) && !isRevealed(), minimized: false, connectedAt: null,
    });
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    startTone('incoming');
    void this.joinCallChannel(conv.id);
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
    if (this.snap.m.phase !== 'incoming' || !this.conv) return;
    stopTone();
    this.dispatch({ t: 'accept' });
    try {
      await this.getMedia(this.snap.video);
    } catch {
      try { await this.getMedia(false); } catch { this.dispatch({ t: 'failed', reason: 'no-media' }); return; }
    }
    if (this.phaseNow() !== 'connecting') return;
    await this.prepareTransport();
    await this.joinCallChannel(this.conv.id);
    await this.send({ k: 'join', fe: !!this.frames, video: this.snap.cam });
    void sb().rpc('call_answered', { msg: this.snap.callId }).then(() => undefined, () => undefined);
    this.timers.push(setTimeout(() => { if (this.snap.m.phase === 'connecting') this.dispatch({ t: 'timeout' }); }, CONNECT_MS));
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
        this.roster.set(s.from, { fe: b.fe, video: b.video });
        if (from.userId === this.userId) {
          if (this.snap.m.phase === 'incoming') this.dispatch({ t: 'answered-elsewhere' });
          return;
        }
        if (!this.inCall()) return;
        await this.send({ k: 'here', fe: !!this.frames, video: this.snap.cam }, s.from);
        if (me < s.from) await this.connectTo(s.from);
        return;
      case 'here':
        this.roster.set(s.from, { fe: b.fe, video: b.video });
        if (this.inCall() && me < s.from) await this.connectTo(s.from);
        return;
      case 'offer':
        if (this.inCall()) await this.onOffer(s.from, b.sdp, b.fe);
        return;
      case 'answer': {
        const p = this.peers.get(s.from);
        if (p && p.pc.signalingState === 'have-local-offer') await p.pc.setRemoteDescription({ type: 'answer', sdp: b.sdp }).catch((e) => console.warn('call answer', e));
        return;
      }
      case 'state': {
        const p = this.peers.get(s.from);
        if (p) { p.mic = b.mic; p.cam = b.cam; this.bumpPeers(); }
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
  private makePeer(ep: string, initiator: boolean, fe: boolean): Peer {
    const userId = parseEndpoint(ep)!.userId;
    const config: RTCConfiguration & { encodedInsertableStreams?: boolean } = {
      iceServers: this.ice?.iceServers as RTCIceServer[] | undefined,
      iceTransportPolicy: this.relayOnly ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      ...(fe && this.frames?.mode === 'streams' ? { encodedInsertableStreams: true } : {}),
    };
    const pc = new RTCPeerConnection(config);
    const peer: Peer = {
      ep, userId, pc, stream: new MediaStream(), initiator, fe, state: 'connecting', mic: true, cam: !!this.roster.get(ep)?.video,
      quality: null, relayed: null, safety: null, restarted: false, lostTimer: null, prev: { lost: 0, recv: 0 }, bytesReceived: 0,
    };
    pc.ontrack = (e) => {
      if (fe) this.attachTransforms(peer);
      peer.stream.addTrack(e.track);
      this.bumpPeers();
    };
    pc.onconnectionstatechange = () => this.onPeerState(peer);
    this.peers.set(ep, peer);
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
      if (t.receiver.track.kind === 'video') preferVp8(t);
    }
  }

  private async connectTo(ep: string) {
    if (this.peers.has(ep) || !this.local) return;
    const fe = !!this.frames && !!this.roster.get(ep)?.fe;
    const peer = this.makePeer(ep, true, fe);
    const pc = peer.pc;
    pc.addTransceiver(this.audioTrack() ?? 'audio', { direction: 'sendrecv', streams: [this.local] });
    pc.addTransceiver(this.videoTrack() ?? 'video', { direction: 'sendrecv', streams: [this.local] });
    this.attachTransforms(peer);
    await this.offer(peer, false);
  }

  private async offer(peer: Peer, iceRestart: boolean) {
    const pc = peer.pc;
    await pc.setLocalDescription(await pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
    await waitForIce(pc);
    if (pc.connectionState === 'closed' || !pc.localDescription) return;
    await this.send({ k: 'offer', sdp: pc.localDescription.sdp, fe: peer.fe }, peer.ep);
  }

  private async onOffer(ep: string, sdp: string, theirFe: boolean) {
    let peer = this.peers.get(ep);
    const fresh = !peer;
    if (!peer) peer = this.makePeer(ep, false, theirFe && !!this.frames);
    const pc = peer.pc;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (fresh && this.local) {
      this.attachTransforms(peer);
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        t.direction = 'sendrecv';
        await t.sender.replaceTrack(kind === 'audio' ? this.audioTrack() : this.videoTrack());
        try { t.sender.setStreams?.(this.local); } catch { /* older browsers */ }
      }
    }
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);
    if (pc.connectionState === 'closed' || !pc.localDescription) return;
    await this.send({ k: 'answer', sdp: pc.localDescription.sdp, fe: peer.fe }, ep);
  }

  private onPeerState(peer: Peer) {
    const st = peer.pc.connectionState;
    if (st === 'connected') {
      if (peer.lostTimer) { clearTimeout(peer.lostTimer); peer.lostTimer = null; }
      peer.state = 'connected';
      this.bumpPeers();
      this.dispatch({ t: 'peer-connected', count: this.connectedCount() });
      void this.computeSafety(peer);
      this.startStats();
      void this.send({ k: 'state', mic: this.snap.mic, cam: this.snap.cam }, peer.ep);
    } else if (st === 'disconnected' || st === 'failed') {
      peer.state = 'reconnecting';
      this.bumpPeers();
      if (st === 'failed' && peer.initiator && !peer.restarted) {
        peer.restarted = true;
        void this.offer(peer, true).catch(() => undefined);
      }
      peer.lostTimer ??= setTimeout(() => { if (peer.pc.connectionState !== 'connected') this.closePeer(peer.ep); }, RECONNECT_MS);
    } else if (st === 'closed') {
      this.closePeer(peer.ep);
    }
  }

  private connectedCount() { return [...this.peers.values()].filter((p) => p.state === 'connected').length; }

  private closePeer(ep: string) {
    const p = this.peers.get(ep);
    if (!p) return;
    this.peers.delete(ep);
    if (p.lostTimer) clearTimeout(p.lostTimer);
    try { p.pc.close(); } catch { /* already closed */ }
    p.stream.getTracks().forEach((t) => t.stop());
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

  // ------------------------------------------------------------------------------------ stats
  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => { void this.pollStats(); }, 2000);
  }

  private async pollStats() {
    for (const p of this.peers.values()) {
      try {
        const report = await p.pc.getStats();
        let pairId: string | null = null;
        let rtt: number | null = null;
        let lost = 0, recv = 0, bytes = 0;
        report.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
          if (s.type === 'inbound-rtp') { lost += s.packetsLost ?? 0; recv += s.packetsReceived ?? 0; bytes += s.bytesReceived ?? 0; }
        });
        if (!pairId) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id; });
        const pair = pairId ? report.get(pairId) : null;
        if (pair) {
          rtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null;
          const lc = report.get(pair.localCandidateId);
          const rc = report.get(pair.remoteCandidateId);
          p.relayed = lc?.candidateType === 'relay' || rc?.candidateType === 'relay';
        }
        const dl = lost - p.prev.lost;
        const dr = recv - p.prev.recv;
        p.prev = { lost, recv };
        const loss = dr + dl > 0 ? dl / (dr + dl) : 0;
        p.bytesReceived = bytes;
        p.quality = rtt === null && dr === 0 ? p.quality
          : (rtt ?? 0) < 0.3 && loss < 0.02 ? 'good' : (rtt ?? 0) < 0.6 && loss < 0.08 ? 'fair' : 'poor';
      } catch { /* closed meanwhile */ }
    }
    this.set({ peers: this.peerViews(), frameStats: this.frames ? this.frames.stats() : null });
  }

  // ------------------------------------------------------------------------------------ controls
  toggleMic() {
    const t = this.audioTrack();
    if (!t) return;
    t.enabled = !t.enabled;
    this.set({ mic: t.enabled });
    void this.send({ k: 'state', mic: t.enabled, cam: this.snap.cam });
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
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.snap.facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
        const track = s.getVideoTracks()[0]!;
        this.local.addTrack(track);
        await this.replaceVideo(track);
        this.set({ cam: true, local: this.local });
      } catch { return; }
    }
    void this.send({ k: 'state', mic: this.snap.mic, cam: this.snap.cam });
  }

  async switchCamera() {
    const cur = this.videoTrack();
    if (!this.local || !cur) return;
    const facing = this.snap.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } } });
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
    }));
  }

  setMinimized(v: boolean) { this.set({ minimized: v }); }
  setSink(id: string) { this.set({ sinkId: id }); }

  // ------------------------------------------------------------------------------------ teardown
  /** The call ended (any reason): release everything, show "Call ended" briefly, then go idle. */
  private finish() {
    const wasConnected = this.snap.m.everConnected;
    stopTone();
    if (wasConnected || this.snap.m.reason !== 'elsewhere') endTone();
    if (this.snap.callId) this.ended.add(this.snap.callId);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    for (const ep of [...this.peers.keys()]) {
      const p = this.peers.get(ep)!;
      try { p.pc.close(); } catch { /* ignore */ }
      p.stream.getTracks().forEach((t) => t.stop());
    }
    this.peers.clear();
    this.roster.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.frames?.close();
    this.frames = null;
    this.callKey = null;
    this.leaveCallChannel();
    this.set({ local: null, peers: [], minimized: false });
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.resetNow(), ENDED_SHOW_MS);
  }

  private resetNow() {
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    if (isLive(this.snap.m.phase) || this.snap.m.phase === 'incoming') return;
    this.conv = null;
    this.convKey = null;
    this.snap = { ...EMPTY, relay: this.snap.relay, sinkId: this.snap.sinkId };
    this.listeners.forEach((l) => l());
  }

  dismiss() { if (this.snap.m.phase === 'ended') this.resetNow(); }
}

export const calls = new CallEngine();

export function useCall(): CallSnapshot {
  return useSyncExternalStore(calls.subscribe, calls.get, () => EMPTY);
}
