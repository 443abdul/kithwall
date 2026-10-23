'use client';
// Presence ("online"/"idle") and typing indicators over Supabase Realtime, privately.
//
// Each user listens on ONE private broadcast channel, `inbox:<my user id>`. Realtime
// Authorization policies on realtime.messages (migration 20261018000400) allow only me to
// receive there, and allow only my friends or conversation co-members to send there. Senders
// post through the Realtime REST broadcast endpoint, batching many inboxes into one request.
//
// Signals carry no content: { k: kind, f: from, t: to, c?: conversation id, ts, s: signature }.
// The server can't vouch for who sent a broadcast, so every signal is signed with the sender's
// identity key and checked here (sender, recipient, kind, conversation and a 2-minute freshness
// window are all covered by the signature). Presence is accepted only from friends; typing
// only from members of that conversation.
//
// Privacy: presence goes only to friends, and nothing is sent at all while chat is turned off
// ("Go offline", settings.chatVisible()). Typing is also suppressed while offline.
import { signChallenge, verifyChallenge, b64u } from '@kithwall/crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { sb, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../supabase';
import { netUrl } from '../net/runtime';
import { getSession, identity } from '../keys/session';
import { people } from '../people';
import { chatVisible } from '../settings';

export type Presence = 'active' | 'idle';
type Kind = 'hello' | 'on' | 'idle' | 'off' | 'typing' | 'stop';
interface Signal { k: Kind; f: string; t: string; c?: string; ts: number; s: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: Kind[] = ['hello', 'on', 'idle', 'off', 'typing', 'stop'];
const HEARTBEAT_MS = 60_000;
const HELLO_MS = 5 * 60_000;
const EXPIRE_MS = 150_000;
const IDLE_AFTER_MS = 5 * 60_000;
const TYPING_SHOW_MS = 6_000;
const TYPING_THROTTLE_MS = 3_000;
const MAX_SKEW_MS = 120_000;
const BATCH = 100;

const signedText = (x: Omit<Signal, 's'>) => `kithwall/v1/chat-signal\n${x.k}\n${x.f}\n${x.t}\n${x.c ?? ''}\n${x.ts}`;

class Signals {
  private userId: string | null = null;
  private channel: RealtimeChannel | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private friends = new Set<string>();
  private convMembers = new Map<string, Set<string>>();
  private online = new Map<string, { status: Presence; at: number }>();
  private typingMap = new Map<string, Map<string, number>>(); // conv -> user -> until
  private lastTypingSent = new Map<string, number>();
  private lastReply = new Map<string, number>();
  private lastHello = 0;
  private lastActivity = Date.now();
  private myStatus: Presence = 'active';
  private visible = true;
  private listeners = new Set<() => void>();
  private cleanup: (() => void)[] = [];
  connected = false;
  version = 0;

  subscribe(l: () => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private bump() { this.version++; this.listeners.forEach((l) => l()); }

  /** Start (idempotent) for the signed-in, unlocked user. */
  start(userId: string) {
    if (this.userId === userId) return;
    if (this.userId) this.stop();
    this.userId = userId;
    this.visible = chatVisible();
    this.channel = sb().channel(`inbox:${userId}`, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'sig' }, ({ payload }) => { void this.receive(payload as Signal); })
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR') console.warn('chat inbox unavailable', err?.message ?? '');
        const was = this.connected;
        this.connected = status === 'SUBSCRIBED';
        if (this.connected && !was) void this.hello();
        if (was !== this.connected) this.bump();
      });
    this.timers.push(setInterval(() => this.tick(), 15_000));
    const activity = () => this.activity();
    const vis = () => { if (document.visibilityState === 'visible') { this.activity(); if (Date.now() - this.lastHello > HEARTBEAT_MS) void this.hello(); } };
    const hide = () => { void this.broadcastPresence('off', [...this.online.keys()], true); };
    const settings = () => this.setVisible(chatVisible());
    for (const ev of ['pointerdown', 'keydown', 'focus', 'wheel', 'touchstart'] as const) window.addEventListener(ev, activity, { passive: true });
    let lastMove = 0;
    const move = () => { const n = Date.now(); if (n - lastMove > 10_000) { lastMove = n; this.activity(); } };
    window.addEventListener('mousemove', move, { passive: true });
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', hide);
    window.addEventListener('kw:settings', settings);
    window.addEventListener('storage', settings);
    this.cleanup.push(() => {
      for (const ev of ['pointerdown', 'keydown', 'focus', 'wheel', 'touchstart'] as const) window.removeEventListener(ev, activity);
      window.removeEventListener('mousemove', move);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('kw:settings', settings);
      window.removeEventListener('storage', settings);
    });
  }

  stop() {
    if (this.channel) void sb().removeChannel(this.channel);
    this.channel = null;
    this.timers.forEach(clearInterval); this.timers = [];
    this.cleanup.forEach((f) => f()); this.cleanup = [];
    this.userId = null; this.connected = false;
    this.online.clear(); this.typingMap.clear(); this.friends.clear(); this.convMembers.clear();
    this.bump();
  }

  get running() { return !!this.userId; }
  isVisible() { return this.visible; }

  /** Friends whose presence I accept (and who get mine). */
  setFriends(ids: string[]) {
    const before = this.friends;
    this.friends = new Set(ids);
    let changed = false;
    for (const id of this.online.keys()) if (!this.friends.has(id)) { this.online.delete(id); changed = true; }
    const added = ids.filter((id) => !before.has(id));
    // New friends (or the first load): say hello so they answer. Before the inbox is joined,
    // the hello on SUBSCRIBED covers everyone.
    if (added.length && this.connected) void this.broadcastPresence('hello', added);
    if (changed) this.bump();
  }

  /** Conversation memberships (for accepting typing signals). */
  setConversations(list: { id: string; members: string[] }[]) {
    this.convMembers = new Map(list.map((c) => [c.id, new Set(c.members)]));
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    if (v) void this.hello();
    else {
      void this.broadcastPresence('off', [...this.friends], true);
      this.online.clear();
    }
    this.bump();
  }

  // ---------------------------------------------------------------------------------- reading

  onlineFriends(): { id: string; status: Presence }[] {
    if (!this.visible) return [];
    const now = Date.now();
    return [...this.online.entries()].filter(([id, s]) => this.friends.has(id) && now - s.at < EXPIRE_MS).map(([id, s]) => ({ id, status: s.status }));
  }

  presenceOf(id: string): Presence | null {
    const s = this.online.get(id);
    return this.visible && s && Date.now() - s.at < EXPIRE_MS ? s.status : null;
  }

  typingIn(convId: string): string[] {
    const m = this.typingMap.get(convId);
    if (!m) return [];
    const now = Date.now();
    return [...m.entries()].filter(([, until]) => until > now).map(([id]) => id);
  }

  /** A message from this person arrived: they've stopped typing. */
  clearTyping(convId: string, userId: string) {
    if (this.typingMap.get(convId)?.delete(userId)) this.bump();
  }

  // ---------------------------------------------------------------------------------- sending

  /** Tell the other members I'm typing (throttled). */
  typing(convId: string, members: string[]) {
    if (!this.userId || !this.visible) return;
    const now = Date.now();
    if (now - (this.lastTypingSent.get(convId) ?? 0) < TYPING_THROTTLE_MS) return;
    this.lastTypingSent.set(convId, now);
    void this.send(members.filter((m) => m !== this.userId).map((to) => this.sign('typing', to, convId)));
  }

  stopTyping(convId: string, members: string[]) {
    if (!this.userId || !this.lastTypingSent.has(convId)) return;
    this.lastTypingSent.delete(convId);
    if (!this.visible) return;
    void this.send(members.filter((m) => m !== this.userId).map((to) => this.sign('stop', to, convId)));
  }

  private activity() {
    this.lastActivity = Date.now();
    if (this.myStatus === 'idle') {
      this.myStatus = 'active';
      void this.broadcastPresence('on', this.knownOnline());
    }
  }

  private knownOnline() { return this.onlineFriends().map((x) => x.id); }

  private async hello() {
    if (!this.userId || !this.visible || !this.friends.size) return;
    this.lastHello = Date.now();
    await this.broadcastPresence('hello', [...this.friends]);
  }

  private tick() {
    if (!this.userId) return;
    const s = getSession();
    if (s.status !== 'ready' || s.userId !== this.userId) { this.stop(); return; }
    const now = Date.now();
    // Expire stale presence and typing.
    let changed = false;
    for (const [id, v] of this.online) if (now - v.at >= EXPIRE_MS) { this.online.delete(id); changed = true; }
    for (const m of this.typingMap.values()) for (const [id, until] of m) if (until <= now) { m.delete(id); changed = true; }
    if (changed) this.bump();
    if (!this.visible) return;
    if (this.myStatus === 'active' && now - this.lastActivity > IDLE_AFTER_MS) {
      this.myStatus = 'idle';
      void this.broadcastPresence('idle', this.knownOnline());
    }
    if (now - this.lastHello > HELLO_MS) void this.hello();
    else if (now - this.lastBeat > HEARTBEAT_MS) {
      this.lastBeat = now;
      void this.broadcastPresence(this.myStatus === 'idle' ? 'idle' : 'on', this.knownOnline());
    }
  }
  private lastBeat = 0;

  private async broadcastPresence(k: 'hello' | 'on' | 'idle' | 'off', to: string[], keepalive = false) {
    if (!this.userId || (k !== 'off' && !this.visible)) return;
    const kind: Kind = k === 'hello' ? 'hello' : k === 'off' ? 'off' : this.myStatus === 'idle' && k === 'on' ? 'idle' : k;
    await this.send(to.filter((id) => this.friends.has(id)).map((id) => this.sign(kind, id)), keepalive);
  }

  private sign(k: Kind, to: string, c?: string): Signal {
    const base = { k, f: this.userId!, t: to, ...(c ? { c } : {}), ts: Date.now() };
    return { ...base, s: signChallenge(identity().signPriv, signedText(base)) };
  }

  private async send(signals: Signal[], keepalive = false) {
    if (!signals.length || !this.userId) return;
    const token = (await sb().auth.getSession()).data.session?.access_token;
    if (!token) return;
    for (let i = 0; i < signals.length; i += BATCH) {
      const messages = signals.slice(i, i + BATCH).map((p) => ({ topic: `inbox:${p.t}`, event: 'sig', payload: p, private: true }));
      try {
        const res = await fetch(netUrl(`${SUPABASE_URL}/realtime/v1/api/broadcast`), {
          method: 'POST', keepalive, credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages }),
        });
        await res.body?.cancel().catch(() => undefined);
      } catch { /* offline: presence is best-effort */ }
    }
  }

  // ---------------------------------------------------------------------------------- receiving

  private async receive(p: Signal) {
    const self = this.userId;
    if (!self || !p || typeof p !== 'object') return;
    if (!KINDS.includes(p.k) || typeof p.f !== 'string' || !UUID.test(p.f) || p.t !== self || p.f === self) return;
    if (typeof p.ts !== 'number' || Math.abs(Date.now() - p.ts) > MAX_SKEW_MS || typeof p.s !== 'string') return;
    if (p.c !== undefined && (typeof p.c !== 'string' || !UUID.test(p.c))) return;
    await people.ensure([p.f]);
    const sender = people.get(p.f);
    if (!sender) return;
    const { s, ...rest } = p;
    let ok = false;
    try { ok = verifyChallenge(b64u.decode(sender.sign_pub), signedText(rest), s); } catch { ok = false; }
    if (!ok) return;

    if (p.k === 'typing' || p.k === 'stop') {
      if (!p.c || !this.convMembers.get(p.c)?.has(p.f)) return;
      let m = this.typingMap.get(p.c);
      if (!m) { m = new Map(); this.typingMap.set(p.c, m); }
      if (p.k === 'typing') {
        m.set(p.f, Date.now() + TYPING_SHOW_MS);
        setTimeout(() => this.bump(), TYPING_SHOW_MS + 50); // hide once it lapses
      } else m.delete(p.f);
      this.bump();
      return;
    }
    if (!this.friends.has(p.f) || !this.visible) return;
    if (p.k === 'off') { this.online.delete(p.f); this.bump(); return; }
    const wasOnline = this.presenceOf(p.f) !== null;
    this.online.set(p.f, { status: p.k === 'idle' ? 'idle' : 'active', at: Date.now() });
    this.bump();
    if (p.k === 'hello' || !wasOnline) {
      // They just came online (or we missed them): answer so they see us too.
      const last = this.lastReply.get(p.f) ?? 0;
      if (Date.now() - last > 20_000) {
        this.lastReply.set(p.f, Date.now());
        void this.broadcastPresence('on', [p.f]);
      }
    }
  }
}

export const signals = new Signals();

export function useSignalsVersion(): number {
  return useSyncExternalStore((l) => signals.subscribe(l), () => signals.version, () => 0);
}
