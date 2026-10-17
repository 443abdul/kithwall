'use client';
// Live chat plumbing shared by the dock and the Messages pages:
//  - one Realtime subscription for new messages (RLS-filtered) → listeners (dock auto-open,
//    typing reset) and a content-free "New message" title flash while the tab is hidden;
//  - which thread is on screen (so we don't pop a chat window for it);
//  - re-keying: when a conversation I own has had a membership change, rotate its key.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { sb } from '../supabase';
import { getSession } from '../keys/session';
import type { MessageRow } from '../types';
import { rotateConversation, type ConversationSummary } from '../messages';

type Listener = (m: MessageRow) => void;

let channel: RealtimeChannel | null = null;
let userId: string | null = null;
const listeners = new Set<Listener>();
let viewing: string | null = null;

export const live = {
  start(uid: string) {
    if (userId === uid && channel) return;
    this.stop();
    userId = uid;
    channel = sb().channel(`chat-live:${uid}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
        const m = p.new as MessageRow;
        if (!m?.id || m.sender_id === userId) return;
        listeners.forEach((l) => l(m));
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') titleFlash.start();
      })
      .subscribe();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', titleFlash.onVisibility);
  },
  stop() {
    if (channel) void sb().removeChannel(channel);
    channel = null; userId = null;
    titleFlash.stop();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', titleFlash.onVisibility);
  },
  onMessage(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  /** The Messages page showing this conversation (null when none). */
  setViewing(convId: string | null) { viewing = convId; },
  viewing: () => viewing,
};

// ------------------------------------------------------------------------------------------
// Title flash: alternate the tab title with "New message" until the tab is visible again.
const titleFlash = {
  timer: null as ReturnType<typeof setInterval> | null,
  base: '',
  start() {
    if (this.timer) return;
    this.base = document.title;
    let on = false;
    this.timer = setInterval(() => { on = !on; document.title = on ? 'New message' : titleFlash.base; }, 1500);
    document.title = 'New message';
  },
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    document.title = this.base;
  },
  onVisibility() { if (document.visibilityState === 'visible') titleFlash.stop(); },
};

// ------------------------------------------------------------------------------------------
// Re-keying (owner's device). Conversations flag `rekey_needed` when membership changes.
const attempted = new Map<string, number>();

export function rekeyWhereNeeded(convs: ConversationSummary[] | undefined) {
  const me = getSession().userId;
  if (!convs || !me) return;
  for (const c of convs) {
    if (!c.rekey_needed || c.ownerId !== me) continue;
    const key = `${c.id}:${c.epoch}`;
    if (Date.now() - (attempted.get(key) ?? 0) < 30_000) continue;
    attempted.set(key, Date.now());
    void rotateConversation(c).catch((e) => console.warn('conversation key rotation failed', e));
  }
}
