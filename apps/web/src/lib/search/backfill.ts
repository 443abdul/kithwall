'use client';
// "Index older messages" (Settings → Your data → Search on this phone). The index normally grows as
// content is seen; this fetches what this device hasn't opened yet (older messages of every chat, then
// older posts of the feed), decrypts it here like any other reading, and lets the usual hooks note it
// (lib/messages readMessage, lib/content readPost). The server sees ordinary requests for my own chats and
// feed, nothing about search.
//
// It runs in the background of the open app (it survives moving between screens, not closing the app), can
// be stopped, starts only when asked, and is gentle: one page at a time with a pause in between, longer
// pauses while Data Saver is on (text only is fetched: no photos, no videos), and it waits while offline.
import { useSyncExternalStore } from 'react';
import { fetchFeed, readPost } from '../content';
import { keyring } from '../keys/keyring';
import { getSession, onLock } from '../keys/session';
import { fetchMessages, readMessage, type ConversationRow } from '../messages';
import { dataSaverActive } from '../net/dataSaver';
import { sb, must } from '../supabase';
import { searchEnabled, searchIndex } from './index';
import { MAX_DOCS } from './store';

export interface BackfillState {
  running: boolean;
  /** Finished without being stopped (until the next start). */
  done: boolean;
  failed: boolean;
  /** Stopped because the index reached its size limit. */
  full: boolean;
  chats: number;
  chatsDone: number;
  messages: number;
  posts: number;
}

const IDLE: BackfillState = { running: false, done: false, failed: false, full: false, chats: 0, chatsDone: 0, messages: 0, posts: 0 };
let state: BackfillState = IDLE;
let run = 0;
const listeners = new Set<() => void>();
const set = (patch: Partial<BackfillState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

const PAGE = 100;
/** Per chat and for the feed: enough for years of talk, bounded so one huge group can't use the whole index. */
const MAX_PER_CHAT = 6000;
const MAX_POSTS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function breathe(mine: number): Promise<boolean> {
  await sleep(dataSaverActive() ? 900 : 200);
  // No connection: wait for it rather than fail (checked every few seconds, stoppable).
  while (mine === run && typeof navigator !== 'undefined' && navigator.onLine === false) await sleep(3000);
  return mine === run;
}

async function allConversations(): Promise<ConversationRow[]> {
  const out: ConversationRow[] = [];
  for (let from = 0; from < 1000; from += 200) {
    const rows = must(await sb().from('conversations').select('*').order('last_message_at', { ascending: false }).range(from, from + 199)) as ConversationRow[];
    out.push(...rows);
    if (rows.length < 200) break;
  }
  return out;
}

async function work(mine: number): Promise<void> {
  await keyring.whenReady();
  await searchIndex.ready();
  const convs = await allConversations();
  if (mine !== run) return;
  set({ chats: convs.length });
  for (const conv of convs) {
    let before: string | undefined;
    for (let seen = 0; seen < MAX_PER_CHAT;) {
      if (searchIndex.size >= MAX_DOCS) { set({ full: true }); return; }
      const rows = await fetchMessages(conv, before, PAGE);
      if (mine !== run) return;
      let found = 0;
      // Reading is what indexes: readMessage notes every message it could decrypt and verify.
      for (const row of rows) if (!row.notice && !row.unsent_at && readMessage(conv, row).ok) found++;
      seen += rows.length;
      set({ messages: state.messages + found });
      if (rows.length < PAGE) break;
      before = rows[0]!.created_at;
      if (!(await breathe(mine))) return;
    }
    set({ chatsDone: state.chatsDone + 1 });
    if (!(await breathe(mine))) return;
  }
  let before: string | undefined;
  for (let seen = 0; seen < MAX_POSTS;) {
    if (searchIndex.size >= MAX_DOCS) { set({ full: true }); return; }
    const rows = await fetchFeed(before, 50);
    if (mine !== run) return;
    let found = 0;
    for (const row of rows) if (readPost(row).ok) found++;
    seen += rows.length;
    set({ posts: state.posts + found });
    if (rows.length < 50) break;
    before = rows[rows.length - 1]!.created_at;
    if (!(await breathe(mine))) return;
  }
}

/** Start (or restart) indexing older messages and posts. */
export function startBackfill(): void {
  if (state.running || !searchEnabled() || getSession().status !== 'ready') return;
  const mine = ++run;
  state = { ...IDLE, running: true };
  listeners.forEach((l) => l());
  void work(mine)
    .then(async () => { await searchIndex.flush(); if (mine === run) set({ running: false, done: !state.full }); })
    .catch(() => { if (mine === run) set({ running: false, failed: true }); });
}

export function stopBackfill(): void {
  run++;
  if (state.running) set({ running: false });
}

// Locking or signing out ends it (the keys are gone).
onLock(() => { run++; state = IDLE; listeners.forEach((l) => l()); });

export function useBackfill(): BackfillState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state, () => IDLE);
}
