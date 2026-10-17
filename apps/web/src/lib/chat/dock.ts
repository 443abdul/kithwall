'use client';
// Chat dock state: which chat windows are open/minimised and whether the buddy list is open.
// Lives in a module store so it survives page navigation (the dock re-mounts with each page),
// and in sessionStorage so it survives reloads in this tab. Only ids are stored, never content.
import { useSyncExternalStore } from 'react';

export interface ChatWin {
  /** Conversation id once known. */
  convId: string | null;
  /** For one-to-one chats: the other person (lets us open a window before a conversation exists). */
  userId: string | null;
  min: boolean;
}
interface DockState { wins: ChatWin[]; list: boolean }

const KEY = 'kw.chatdock';
const MAX_WINDOWS = 3;
const UUID = /^[0-9a-f-]{36}$/;

let state: DockState = load();
const listeners = new Set<() => void>();

function load(): DockState {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
    if (!raw) return { wins: [], list: false };
    const v = JSON.parse(raw) as DockState;
    const wins = (Array.isArray(v.wins) ? v.wins : [])
      .filter((w) => (w.convId === null || (typeof w.convId === 'string' && UUID.test(w.convId)))
        && (w.userId === null || (typeof w.userId === 'string' && UUID.test(w.userId))) && (w.convId || w.userId))
      .map((w) => ({ convId: w.convId, userId: w.userId, min: !!w.min }))
      .slice(0, MAX_WINDOWS);
    return { wins, list: !!v.list };
  } catch { return { wins: [], list: false }; }
}

function set(next: DockState) {
  state = next;
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

const same = (a: ChatWin, b: Partial<ChatWin>) =>
  (!!b.convId && a.convId === b.convId) || (!!b.userId && a.userId === b.userId && (!a.convId || !b.convId || a.convId === b.convId));

export const dock = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },

  toggleList() { set({ ...state, list: !state.list }); },
  closeList() { if (state.list) set({ ...state, list: false }); },

  /** Open (or restore) a chat window; the oldest window closes beyond three. */
  open(w: { convId?: string | null; userId?: string | null }, opts: { focus?: boolean; minimized?: boolean } = {}) {
    const existing = state.wins.find((x) => same(x, w));
    if (existing) {
      const updated = { ...existing, convId: existing.convId ?? w.convId ?? null, min: opts.minimized ?? (opts.focus ? false : existing.min) };
      set({ ...state, wins: state.wins.map((x) => (x === existing ? updated : x)) });
      return;
    }
    const win: ChatWin = { convId: w.convId ?? null, userId: w.userId ?? null, min: !!opts.minimized };
    set({ ...state, list: opts.focus ? false : state.list, wins: [...state.wins, win].slice(-MAX_WINDOWS) });
  },

  /** A window for a person got its conversation (first message sent). */
  attach(userId: string, convId: string) {
    set({ ...state, wins: state.wins.map((x) => (x.userId === userId && !x.convId ? { ...x, convId } : x)) });
  },

  toggleMin(w: ChatWin) { set({ ...state, wins: state.wins.map((x) => (x === w ? { ...x, min: !x.min } : x)) }); },
  close(w: ChatWin) { set({ ...state, wins: state.wins.filter((x) => x !== w) }); },
  closeConversation(convId: string) { set({ ...state, wins: state.wins.filter((x) => x.convId !== convId) }); },
  reset() { set({ wins: [], list: false }); },
};

const EMPTY: DockState = { wins: [], list: false };
export function useDock(): DockState {
  return useSyncExternalStore(dock.subscribe, dock.get, () => EMPTY);
}
