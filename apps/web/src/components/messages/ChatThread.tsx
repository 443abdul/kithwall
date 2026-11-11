'use client';
// One chat (Kithwall 2): header, the conversation as bubbles (day separators, runs, replies, photos,
// videos, link cards, reactions), optimistic sending, optional typing and read receipts, composer.
// Phase 3: disappearing messages (timer in the header, expired messages leave the screen at once, timer
// notices inline, a one-time suggestion in older chats), edits ("edited") and live unsend.
// Games (docs/v2/11-games.md): a game's messages show as ONE card that updates in place; a move goes through
// the same send queue as any message, so one made offline is sent when the connection is back.
import { VerifiedBadge } from '@/lib/transparency/verified';
import { isHiddenChat } from '@/lib/safety/hidden';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { myFriendIds } from '@/lib/friends';
import { invalidateSoon } from '@/lib/invalidate';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { useKeyringVersion } from '@/lib/hooks';
import { usePeopleVersion } from '@/lib/people';
import { useSettings } from '@/lib/settings';
import { readMessage, type ChatPayload, type ConversationSummary } from '@/lib/messages';
import { useConversation, useMarkRead, useMessages, useTyping } from '@/lib/chat/hooks';
import { live, rekeyWhereNeeded } from '@/lib/chat/live';
import { readReaction, REACTIONS, useReactions } from '@/lib/chat/reactions';
import { useReceipts } from '@/lib/chat/privacy';
import type { MessageRow } from '@/lib/types';
import { Button, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/components/ui/cx';
import { buildThread, dayBucket, isEmojiOnly, snippet, tallyReactions, type ChatLine } from './chatModel';
import { ConversationAvatar, useConversationTitle, useNameOf, PersonAvatar } from './look';
import { MessageText, eventLine, previewText } from './content';
import { ChatAttachments, LinkCard } from './ChatMedia';
import { VoiceNote, voiceOf } from './VoiceNote';
import { ChatComposer, type ReplyTarget } from './ChatComposer';
import { MessageActions } from './MessageActions';
import { ChatInfo } from './ChatInfo';
import { ChatIcon } from './ChatIcon';
import { sendDraft, SendError, type Draft } from './send';
import { useSwipeBack, useVisualViewportHeight } from './runtime';
import { OldChatSuggestion, TimerHint } from './Ephemeral';
import { CallButtons } from '@/components/calls/CallButtons';
import { ChatKeyNotices } from '@/components/verify/ChatKeyNotices';
import { Translatable } from '@/components/translate/Translatable';
import { useSearchParams } from 'next/navigation';
import { forgetMessage } from '@/lib/search';
import { ChatSearch } from '@/components/search/ChatSearch';
import { useToast } from '@/components/ui/Toast';
import { inviteEvent, nextEvent, type Action, type NewGame } from '@/lib/games/match';
import { buildGames, type GameView } from '@/lib/games/thread';
import { gameItems, gameOf, secretsFor, serverNow } from '@/lib/games/play';
import { GameCard, type SendState } from '@/components/games/GameCard';
import { GameDialog } from '@/components/games/GameDialog';
import { NewGameDialog } from '@/components/games/NewGame';

interface Line extends ChatLine { row: MessageRow; payload: ChatPayload | null }
/** 'queued': failed because the device is offline; it is sent again by itself when the connection is back. */
interface Pending { tempId: string; draft: Draft; status: 'sending' | 'failed' | 'queued'; progress: number; error?: string }

/** Messages still being sent or waiting for a connection, per conversation: kept outside the thread
 *  component so leaving the chat (or switching chats) doesn't silently drop them. */
const pendingByChat = new Map<string, Pending[]>();

/** Did a send fail because there is no connection (rather than being refused)? */
function offlineFailure(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const m = (e as Error)?.message ?? '';
  return /failed to fetch|networkerror|network request failed|load failed|err_internet|timed? ?out/i.test(m);
}

/** Scroll a message of the open thread into view and flash it (quoted replies, search results). */
function flashMessage(mid: string) {
  const el = document.getElementById(`m-${mid}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1400);
}

function useDayLabel() {
  const t = useT();
  const f = useFormat();
  return (iso: string) => {
    const b = dayBucket(iso);
    if (b === 'today') return t('messages.today');
    if (b === 'yesterday') return t('messages.yesterday');
    const d = new Date(iso);
    if (b === 'week') return f.date(d, { weekday: 'long' });
    return f.date(d, { dateStyle: 'medium' });
  };
}

export function ChatThread({ id }: { id: string }) {
  const t = useT();
  const conv = useConversation(id);
  const c = conv.data ?? null;
  if (conv.isLoading) return <div className="k-chat-thread k-chat-center"><Spinner size={28} /></div>;
  if (!c) {
    return (
      <div className="k-chat-thread k-chat-center">
        <EmptyState icon="sealed" title={conv.isError ? t('messages.loadFailed') : t('messages.notFoundTitle')}
          body={conv.isError ? undefined : t('messages.notFoundBody')}
          actions={<Link className="k-btn k-btn-secondary" href="/messages">{t('messages.backToList')}</Link>} />
      </div>
    );
  }
  return <Thread key={c.id} c={c} />;
}

function Thread({ c }: { c: ConversationSummary }) {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const toast = useToast();
  const { userId } = useSession();
  const s = useSettings();
  const pv = usePeopleVersion();
  const kv = useKeyringVersion();
  const nameOf = useNameOf();
  const title = useConversationTitle(c);
  const dayLabel = useDayLabel();
  const msgs = useMessages(c.id);
  const typing = useTyping(s.typingIndicator ? c.id : null);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pending, setPendingState] = useState<Pending[]>(() => pendingByChat.get(c.id) ?? []);
  // The per-chat store is the source of truth (a send that finishes after I left the chat still updates it).
  const setPending = useCallback((fn: (p: Pending[]) => Pending[]) => {
    const next = fn(pendingByChat.get(c.id) ?? []);
    if (next.length) pendingByChat.set(c.id, next); else pendingByChat.delete(c.id);
    setPendingState(next);
  }, [c.id]);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [acting, setActing] = useState<Line | null>(null);
  const [info, setInfo] = useState<false | 'main' | 'timer' | 'games'>(false);
  const [game, setGame] = useState<string | null>(null);
  const [newGame, setNewGame] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(false);
  useVisualViewportHeight(root);
  useSwipeBack(root, '/messages');
  useMarkRead(c, true);
  useEffect(() => { live.setViewing(c.id); return () => live.setViewing(null); }, [c.id]);
  useEffect(() => { rekeyWhereNeeded([c]); }, [c]);
  // Edits and unsends arrive live (lib/chat/live useMessagesLive); this slow re-check is only a safety net
  // for a dropped Realtime connection.
  useEffect(() => {
    const h = setInterval(() => {
      if (document.visibilityState === 'visible') void qc.invalidateQueries({ queryKey: ['messages', c.id] });
    }, 60_000);
    return () => clearInterval(h);
  }, [c.id, qc]);

  const others = c.members.filter((m) => m !== userId);
  const isGroup = !c.isDm && (others.length > 1 || c.kind === 'group');

  const lines: Line[] = useMemo(() => msgs.rows.map((row) => {
    const d = readMessage(c, row);
    // Game messages are never bubbles: one of them carries the game's card, the rest stay out of sight.
    return { id: row.id, sender: row.sender_id, at: row.created_at, event: d.ok && (!!d.value.event || d.value.game !== undefined), row, payload: d.ok ? d.value : null };
    // kv / pv: re-read when keys or people arrive ("waiting for a key" results are not cached)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [msgs.rows, c, kv, pv]);
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  // The games in these messages, with my own moves that are still being sent applied on top.
  const games = useMemo(() => {
    const found = gameItems(lines);
    for (const p of pending) {
      if (p.draft.game && p.draft.id && userId) found.push({ id: p.draft.id, sender: userId, at: new Date(serverNow()).toISOString(), edited: false, ev: p.draft.game, pending: true });
    }
    // A message that can't be opened yet may be a game message: its neighbours are not called made up.
    return buildGames(found, userId, lines.some((l) => !l.payload));
  }, [lines, pending, userId]);
  const cards = useMemo(() => new Map(games.filter((v) => v.cardRow).map((v) => [v.cardRow!, v])), [games]);
  const refused = useMemo(() => new Set(games.flatMap((v) => v.refused.map((r) => r.id))), [games]);
  const shown = useMemo(() => lines.filter((l) => l.payload?.game === undefined || cards.has(l.id) || refused.has(l.id) || gameOf(l.payload) === 'bad'), [lines, cards, refused]);
  const items = useMemo(() => buildThread(shown), [shown]);
  const ids = useMemo(() => lines.map((l) => l.id), [lines]);
  const reactions = useReactions(c.id, ids);
  const newest = lines[lines.length - 1]?.id;
  const receipts = useReceipts(c.id, s.readReceipts, newest);

  const reactionsOf = useMemo(() => {
    const m = new Map<string, { userId: string; emoji: string }[]>();
    for (const r of reactions.data ?? []) {
      const e = readReaction(c.audience_id, r);
      if (!e) continue;
      const xs = m.get(r.message_id) ?? [];
      xs.push({ userId: r.user_id, emoji: e });
      m.set(r.message_id, xs);
    }
    return m;
  }, [reactions.data, c.audience_id]);

  // My newest message, and who has read it (only with read receipts on, both sides).
  const myLast = [...lines].reverse().find((l) => l.sender === userId && !l.event);
  const seenBy = myLast && s.readReceipts ? (receipts.data ?? []).filter((r) => r.last_read_at >= myLast.at).map((r) => r.user_id) : [];

  // Scrolling: start at the bottom, follow new messages while at the bottom, keep the position when
  // older messages are loaded above.
  const firstId = lines[0]?.id;
  const prevFirst = useRef<string | undefined>(undefined);
  const prevHeight = useRef(0);
  const didInit = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!didInit.current && lines.length) {
      el.scrollTop = el.scrollHeight;
      didInit.current = true;
    } else if (prevFirst.current && firstId !== prevFirst.current && prevHeight.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current; // older page prepended
    }
    prevFirst.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [firstId, lines.length]);
  const lastKey = `${newest ?? ''}:${pending.length}:${typing.length}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !didInit.current) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else setNewBelow(true);
    prevHeight.current = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (bottom) setNewBelow(false);
    if (el.scrollTop < 120 && msgs.hasOlder && !msgs.isFetchingNextPage) void msgs.loadOlder();
  };
  const toBottom = () => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); setNewBelow(false); };

  const send = useCallback((input: Draft) => {
    const tempId = crypto.randomUUID();
    const draft: Draft = { ...input, id: input.id ?? crypto.randomUUID() };
    setReply(null);
    setAtBottom(true);
    setPending((p) => [...p, { tempId, draft, status: 'sending', progress: 0 }]);
    const run = async () => {
      try {
        await sendDraft(c, draft, (x) => setPending((p) => p.map((q) => (q.tempId === tempId ? { ...q, progress: x } : q))));
        await qc.invalidateQueries({ queryKey: ['messages', c.id] });
        setPending((p) => p.filter((q) => q.tempId !== tempId));
        invalidateSoon(qc, ['conversations']);
      } catch (e) {
        const code = e instanceof SendError ? e.code : 'failed';
        // Offline (a shutdown, a tunnel, flight mode): keep it and send it when the connection returns.
        const queued = code === 'failed' && offlineFailure(e);
        setPending((p) => p.map((q) => (q.tempId === tempId
          ? { ...q, status: queued ? 'queued' : 'failed', error: queued ? t('messages.queued') : t(`messages.error.${code}` as MessageKey) } : q)));
      }
    };
    void run();
  }, [c, qc, t, setPending]);

  // Games: every action (accept, move, resign…) is written by the same rule book that checks it on the
  // other devices, then sent like any message. `sentHere`: the game messages this device sent.
  const sentHere = useRef(new Set<string>());
  const resent = useRef(new Set<string>());
  const playGame = useCallback((view: GameView, a: Action) => {
    if (!userId) return;
    const res = nextEvent(view.head, userId, a, secretsFor(view.id), serverNow());
    if (!res.ok) { toast({ message: t(res.why === 'early' ? 'games.error.early' : 'games.error.illegal'), tone: 'danger' }); return; }
    const id = crypto.randomUUID();
    sentHere.current.add(id);
    send({ text: '', files: [], game: res.ev, id });
  }, [userId, send, toast, t]);
  const startGame = useCallback((g: NewGame) => {
    // The invitation's message id is the game's id.
    const gid = crypto.randomUUID();
    const ev = inviteEvent(gid, g, secretsFor(gid));
    if (!ev) { toast({ message: t('games.error.illegal'), tone: 'danger' }); return; }
    send({ text: '', files: [], game: ev, id: gid });
  }, [send, toast, t]);
  // A game message of mine that lost a race for its place (two people accepted at the same moment; I moved
  // just as the other player offered a draw) is sent again on top of the message that won, once, if it is
  // still allowed there. Only messages this device sent, and only while nothing else has happened since.
  useEffect(() => {
    if (!userId) return;
    for (const v of games) {
      if (v.pending) continue;
      for (const d of v.dropped) {
        if (d.sender !== userId || !sentHere.current.has(d.id) || resent.current.has(d.id)) continue;
        resent.current.add(d.id);
        const a = d.ev.a;
        const res = nextEvent(v.head, userId, a.t === 'move' ? { t: 'move', m: a.m } : { t: a.t }, secretsFor(v.id), serverNow());
        if (!res.ok) continue;
        const id = crypto.randomUUID();
        sentHere.current.add(id);
        // After this render pass, like a tap would.
        queueMicrotask(() => send({ text: '', files: [], game: res.ev, id }));
      }
    }
  }, [games, userId, send]);
  const sendingOf = (view: GameView): SendState => pending.find((p) => p.draft.game?.g === view.id)?.status ?? null;
  const openView = game ? games.find((v) => v.id === game) ?? null : null;
  // An open game whose first messages aren't loaded yet: page back until its invitation is there (or until
  // everything left in the chat is newer than it, when it has disappeared).
  const oldestAt = lines[0]?.at;
  const { hasOlder, isFetchingNextPage, loadOlder } = msgs;
  useEffect(() => {
    if (!openView || openView.complete || !hasOlder || isFetchingNextPage) return;
    if (openView.match.t0 && oldestAt && Date.parse(oldestAt) < openView.match.t0) return;
    void loadOlder();
  }, [openView, oldestAt, hasOlder, isFetchingNextPage, loadOlder]);

  const retry = (p: Pending) => { setPending((xs) => xs.filter((q) => q.tempId !== p.tempId)); send(p.draft); };
  // Back online: send everything that waited for the connection, in the order it was written.
  const pendingRef = useRef(pending);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  useEffect(() => {
    const flush = () => {
      const waiting = pendingRef.current.filter((q) => q.status === 'queued');
      if (!waiting.length) return;
      setPending((xs) => xs.filter((q) => q.status !== 'queued'));
      waiting.forEach((q) => send(q.draft));
    };
    window.addEventListener('online', flush);
    const timer = setInterval(() => { if (navigator.onLine) flush(); }, 30_000);
    return () => { window.removeEventListener('online', flush); clearInterval(timer); };
  }, [send]);
  const discard = (p: Pending) => setPending((xs) => xs.filter((q) => q.tempId !== p.tempId));

  const startReply = (l: Line) => {
    setReply({ id: l.id, author: l.sender, authorName: l.sender === userId ? t('messages.you') : nameOf(l.sender), text: l.payload?.text ?? previewText({ ok: true, value: l.payload ?? { text: '' } }, t) });
    setFocusKey((k) => k + 1);
  };

  const jumpTo = flashMessage;

  // Search on your phone (lib/search): go to a message found by search, in this chat's own search or from
  // a result elsewhere (/messages/<chat>?m=<message>). It may be far back: older pages are loaded until it
  // is on the page. If the chat's beginning is reached without it, it is gone (unsent, expired), and it
  // leaves the search index too.
  const [finding, setFinding] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const latest = useRef(msgs);
  useEffect(() => { latest.current = msgs; });
  const goTo = useCallback(async (mid: string) => {
    const there = () => !!document.getElementById(`m-${mid}`);
    setSeeking(true);
    try {
      for (let page = 0; page < 80 && !there() && latest.current.hasOlder; page++) {
        await latest.current.loadOlder();
        await new Promise((r) => setTimeout(r, 60));
      }
    } catch { /* offline: whatever is loaded is all there is for now */ } finally { setSeeking(false); }
    if (there()) { flashMessage(mid); return; }
    if (!latest.current.hasOlder && !latest.current.isError) forgetMessage(mid);
    toast({ message: t('search.gone') });
  }, [t, toast]);
  const wanted = useSearchParams().get('m');
  const sought = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || !/^[0-9a-f-]{36}$/i.test(wanted) || sought.current === wanted || msgs.isLoading || !lines.length) return;
    sought.current = wanted;
    void goTo(wanted.toLowerCase());
  }, [wanted, msgs.isLoading, lines.length, goTo]);

  const subtitle = typing.length
    ? (typing.length === 1 ? t('messages.typingOne', { name: nameOf(typing[0]!).split(' ')[0] ?? '' }) : t('messages.typingMany'))
    : isGroup ? t('messages.members', { count: c.members.length }) : t('messages.sealedShort');
  const disabled = !others.length && c.kind !== 'group' ? t('messages.composer.alone') : null;
  const list = (xs: string[]) => f.list(xs);

  return (
    <div ref={root} className="k-chat-thread">
      <header className="k-chat-head">
        <Link href="/messages" className="k-iconbtn k-chat-back" aria-label={t('messages.backToList')} title={t('messages.backToList')}><Icon name="back" /></Link>
        <button type="button" className="k-chat-head-who" onClick={() => setInfo('main')} aria-label={t('messages.info.open', { title })}>
          <ConversationAvatar c={c} size={40} />
          <span className="k-chat-head-text">
            <span className="k-chat-head-title" dir="auto">{title}{!isGroup && others.length === 1 ? <> <VerifiedBadge userId={others[0]} /></> : null}</span>
            <span className={cx('k-chat-head-sub', typing.length > 0 && 'is-typing')} aria-live="polite">
              {!typing.length && c.disappear_secs
                ? <><span className="k-eph-sub-base">{subtitle}</span><span className="k-eph-sep" aria-hidden> · </span><TimerHint secs={c.disappear_secs} /></>
                : subtitle}
            </span>
          </span>
        </button>
        <CallButtons conversation={c} />
        <IconButton icon="search" label={t('search.inChat')} aria-expanded={finding} className="k-find-headbtn" onClick={() => setFinding((v) => !v)} />
        <IconButton icon="clock" label={t('ephemeral.chat.title')} onClick={() => setInfo('timer')} className={c.disappear_secs ? 'k-eph-headbtn is-on' : 'k-eph-headbtn'} />
        <IconButton icon="info" label={t('messages.info.title')} onClick={() => setInfo('main')} />
      </header>
      {finding ? <ChatSearch c={c} onClose={() => setFinding(false)} onPick={(hit) => void goTo(hit.doc.id.slice(2))} /> : null}
      {seeking ? <div className="k-chat-seeking k-small" role="status"><Spinner size={16} /> {t('search.seeking')}</div> : null}

      <div ref={scroller} className="k-chat-scroll" onScroll={onScroll} role="log" aria-label={t('messages.threadLabel', { title })} aria-live="polite" aria-relevant="additions">
        <div className="k-chat-sealed k-small"><Icon name="lock" /> {t('messages.sealedBanner')}</div>
        <ChatKeyNotices audienceId={c.audience_id} peer={!isGroup && others.length === 1 ? others[0]! : null} name={title}
          authorities={!c.isDm ? c.keyAuthorities : null} />
        {msgs.isFetchingNextPage ? <div className="k-chat-center k-chat-older"><Spinner /></div> : null}
        {msgs.hasOlder && !msgs.isFetchingNextPage ? (
          <div className="k-chat-center k-chat-older"><Button size="sm" variant="ghost" onClick={() => void msgs.loadOlder()}>{t('messages.loadOlder')}</Button></div>
        ) : null}
        {msgs.isLoading ? <div className="k-chat-center"><Spinner size={24} /></div> : null}
        {!msgs.isLoading && !lines.length && !pending.length ? (
          <div className="k-chat-hello">
            <ConversationAvatar c={c} size={72} />
            <p className="k-chat-hello-title">{title}</p>
            <p className="k-small k-muted">{t('messages.sayHi')}</p>
          </div>
        ) : null}
        <ol className="k-chat-lines">
          {items.map((it) => {
            if (it.kind === 'day') return <li key={it.key} className="k-chat-day"><span>{dayLabel(it.at)}</span></li>;
            const l = it.line;
            if (it.kind === 'event' && l.payload?.game !== undefined) {
              const view = cards.get(l.id);
              return view ? (
                <li key={it.key} className="k-chat-event k-gm-line" id={`m-${l.id}`}>
                  <GameCard view={view} me={userId} sending={sendingOf(view)} onOpen={() => setGame(view.id)} onAct={(a) => playGame(view, a)} />
                </li>
              ) : (
                // Refused by this device's own check of the rules: it changes nothing in the game.
                <li key={it.key} className="k-chat-event k-gm-refused" id={`m-${l.id}`}><Icon name="alert" /> {t('games.refused', { name: nameOf(l.sender) })}</li>
              );
            }
            if (it.kind === 'event') {
              const actor = l.sender === userId ? t('messages.you') : nameOf(l.sender);
              const txt = l.payload ? eventLine(l.payload, actor, nameOf, list, t) : null;
              // Someone was made an admin or took the chat over: they can hand out keys (R-K-2), so it stands out.
              const loud = l.payload?.event?.kind === 'roster' && l.payload.event.what !== 'joined';
              return txt ? (
                <li key={it.key} className={loud ? 'k-chat-event is-security' : 'k-chat-event'} id={`m-${l.id}`}>
                  {loud ? <Icon name="shield" /> : null}{txt}
                </li>
              ) : null;
            }
            return (
              <Bubble key={it.key} l={l} c={c} first={it.first} last={it.last} mine={l.sender === userId} isGroup={isGroup}
                replyTo={l.payload?.replyTo ? byId.get(l.payload.replyTo.id) ?? null : null}
                reactions={reactionsOf.get(l.id) ?? []}
                seen={myLast?.id === l.id ? seenBy : null}
                receiptsOn={s.readReceipts}
                onAct={() => setActing(l)} onReply={() => startReply(l)} onJump={jumpTo} />
            );
          })}
          {pending.map((p) => {
            if (!p.draft.game) return null;
            // A move on its way shows on the game's card. Here: a new game that has no stored message to
            // stand on yet, and what to do with a game message that could not be sent.
            const view = games.find((v) => v.id === p.draft.game!.g);
            const lone = !!view && !view.cardRow;
            if (!lone && p.status === 'sending') return null;
            return (
              <li key={p.tempId} className="k-chat-event k-gm-line">
                {lone && view ? <GameCard view={view} me={userId} sending={p.status} onOpen={() => setGame(view.id)} onAct={(a) => playGame(view, a)} /> : null}
                {p.status !== 'sending' ? (
                  <span className={p.status === 'queued' ? 'k-chat-queued' : 'k-chat-failed'} role={p.status === 'queued' ? 'status' : 'alert'}>
                    <Icon name={p.status === 'queued' ? 'clock' : 'alert'} /> {p.status === 'queued' ? t('games.queuedLong') : t('games.failedLong')}
                    <button type="button" className="k-chat-linkbtn" onClick={() => retry(p)}>{t('messages.retry')}</button>
                    <button type="button" className="k-chat-linkbtn" onClick={() => discard(p)}>{t('messages.discard')}</button>
                  </span>
                ) : null}
              </li>
            );
          })}
          {pending.filter((p) => !p.draft.game).map((p) => (
            <li key={p.tempId} className="k-chat-msg is-mine is-first is-last is-pending">
              <div className="k-chat-stack">
                <div className="k-chat-bubble">
                  {p.draft.text ? <p className="k-chat-text"><MessageText text={p.draft.text} /></p> : null}
                  {p.draft.files.length ? <p className="k-chat-text">{t('messages.preview.photo', { count: p.draft.files.length })}</p> : null}
                  {p.draft.voice ? <p className="k-chat-text">{previewText({ ok: true, value: { text: '', voice: { duration: p.draft.voice.duration, peaks: '' } } }, t)}</p> : null}
                </div>
                <div className="k-chat-meta">
                  {p.status === 'sending'
                    ? <span>{(p.draft.files.length || p.draft.voice) && p.progress < 1 ? t('messages.sendingProgress', { percent: Math.round(p.progress * 100) }) : t('messages.sending')}</span>
                    : (
                      <span className={p.status === 'queued' ? 'k-chat-queued' : 'k-chat-failed'} role={p.status === 'queued' ? 'status' : 'alert'}>
                        <Icon name={p.status === 'queued' ? 'clock' : 'alert'} /> {p.error}
                        <button type="button" className="k-chat-linkbtn" onClick={() => retry(p)}>{t('messages.retry')}</button>
                        <button type="button" className="k-chat-linkbtn" onClick={() => discard(p)}>{t('messages.discard')}</button>
                      </span>
                    )}
                </div>
              </div>
            </li>
          ))}
          {typing.length ? (
            <li className="k-chat-msg is-first is-last k-chat-typing" aria-hidden>
              <span className="k-chat-av"><PersonAvatar id={typing[0]} size={28} /></span>
              <div className="k-chat-bubble"><span className="k-chat-dots"><i /><i /><i /></span></div>
            </li>
          ) : null}
        </ol>
      </div>
      {newBelow ? <button type="button" className="k-chat-jump" onClick={toBottom}><Icon name="down" /> {t('messages.newBelow')}</button> : null}

      <OldChatSuggestion c={c} onChoose={() => setInfo('timer')} />
      <ChatComposer convId={c.id} members={c.members} disabled={disabled} reply={reply} onCancelReply={() => setReply(null)} onSend={send} focusKey={focusKey}
        onPlay={() => setNewGame(true)} />

      {acting ? (
        <MessageActions c={c} line={acting} mine={acting.sender === userId}
          myReaction={(reactionsOf.get(acting.id) ?? []).find((r) => r.userId === userId)?.emoji ?? null}
          onReply={() => { const l = acting; setActing(null); startReply(l); }}
          onClose={() => setActing(null)} />
      ) : null}
      <ChatInfo c={c} open={!!info} initialStep={info || 'main'} onClose={() => setInfo(false)} title={title}
        games={games} onOpenGame={(gid) => { setInfo(false); setGame(gid); }} onNewGame={() => { setInfo(false); setNewGame(true); }}
        hasOlder={!!hasOlder} loadingOlder={isFetchingNextPage} onLoadOlder={() => void loadOlder()} onSearch={() => setFinding(true)} />
      {openView ? (
        <GameDialog view={openView} me={userId} sending={sendingOf(openView)} onClose={() => setGame(null)}
          onAct={(a) => playGame(openView, a)} onStart={startGame} />
      ) : null}
      {userId ? <NewGameDialog members={c.members} me={userId} open={newGame} onClose={() => setNewGame(false)} onStart={startGame} /> : null}
    </div>
  );
}

function Bubble({ l, c, first, last, mine, isGroup, replyTo, reactions, seen, receiptsOn, onAct, onReply, onJump }: {
  l: Line; c: ConversationSummary; first: boolean; last: boolean; mine: boolean; isGroup: boolean;
  replyTo: Line | null; reactions: { userId: string; emoji: string }[]; seen: string[] | null; receiptsOn: boolean;
  onAct: () => void; onReply: () => void; onJump: (id: string) => void;
}) {
  const t = useT();
  const f = useFormat();
  const { userId } = useSession();
  const nameOf = useNameOf();
  // Media from people I'm not connected with stays inert until tapped (ChatAttachments `trusted`).
  const friends = useQuery({ queryKey: ['friend-ids'], staleTime: 5 * 60_000, queryFn: myFriendIds });
  const connections = new Set(friends.data ?? []);
  const p = l.payload;
  const d = readMessage(c, l.row);
  const voice = voiceOf(p);
  const beforeJoin = !d.ok && d.reason === 'waiting' && !!c.joinedAt && l.at < c.joinedAt;
  const text = p?.text ?? '';
  const big = !!p && !p.attachments?.length && !p.link && !p.replyTo && isEmojiOnly(text);
  const tally = tallyReactions(reactions, REACTIONS);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const time = f.date(new Date(l.at), { timeStyle: 'short' });
  const quoteAuthor = p?.replyTo ? (p.replyTo.author === userId ? t('messages.you') : nameOf(p.replyTo.author)) : '';
  const quoteText = replyTo ? previewText(replyTo.payload ? { ok: true, value: replyTo.payload } : { ok: false, reason: 'waiting' }, t) : t('messages.quoteUnavailable');

  return (
    <li id={`m-${l.id}`} className={cx('k-chat-msg', mine && 'is-mine', first && 'is-first', last && 'is-last', big && 'is-big')}
      onContextMenu={(e) => { e.preventDefault(); onAct(); }}
      onTouchStart={() => { press.current = setTimeout(onAct, 480); }}
      onTouchEnd={() => { if (press.current) clearTimeout(press.current); }}
      onTouchMove={() => { if (press.current) clearTimeout(press.current); }}>
      {!mine && isGroup ? <span className="k-chat-av">{last ? <PersonAvatar id={l.sender} size={28} /> : null}</span> : null}
      <div className="k-chat-stack">
        {!mine && isGroup && first ? <span className="k-chat-author">{nameOf(l.sender)}</span> : null}
        <div className="k-chat-bubble-row">
          <div className={cx('k-chat-bubble', !d.ok && 'is-sealed', d.ok && !!p?.attachments?.length && !voice && !text && !p.replyTo && !p.link && 'is-media', voice && 'is-voice')}>
            {p?.replyTo ? (
              <button type="button" className="k-chat-quote" onClick={() => onJump(p.replyTo!.id)}>
                <span className="k-chat-quote-who">{quoteAuthor}</span>
                <span className="k-chat-quote-text" dir="auto">{snippet(quoteText, 100)}</span>
              </button>
            ) : null}
            {d.ok && p?.story ? (
              <span className="k-chat-story-tag k-small"><Icon name="sparkle" /> {p.story.author === userId ? t('stories.replyToYours') : t('stories.replyToTheirs')}</span>
            ) : null}
            {d.ok ? (
              <>
                {voice ? <VoiceNote file={voice.file} meta={voice.meta} messageId={l.id} mine={mine} persist={!isHiddenChat(c.id)} /> : null}
                {p?.attachments?.length ? <ChatAttachments files={p.attachments} trusted={mine || connections.has(l.sender)} pending={!mine && !friends.data} /> : null}
                {text ? (
                  <Translatable text={text} variant="chat" textClassName="k-chat-text" mine={mine}>
                    <p className="k-chat-text" dir="auto"><MessageText text={text} /></p>
                  </Translatable>
                ) : null}
                {p?.link ? <LinkCard link={p.link} /> : null}
              </>
            ) : (
              <p className="k-chat-text k-chat-sealedmsg">
                <Icon name={d.reason === 'unverified' ? 'alert' : 'lock'} />{' '}
                {d.reason === 'unverified' ? t('messages.unverified') : beforeJoin ? t('messages.beforeJoin') : t('messages.waitingKey', { name: nameOf(l.sender) })}
              </p>
            )}
          </div>
          <span className="k-chat-tools">
            <button type="button" className="k-iconbtn k-iconbtn-sm" aria-label={t('messages.actions.reply')} title={t('messages.actions.reply')} onClick={onReply}><ChatIcon name="reply" /></button>
            <button type="button" className="k-iconbtn k-iconbtn-sm" aria-label={t('messages.actions.more')} title={t('messages.actions.more')} onClick={onAct}><Icon name="more" /></button>
          </span>
        </div>
        {tally.length ? (
          <div className="k-chat-reactions">
            {tally.map((r) => (
              <button key={r.emoji} type="button" className={cx('k-chat-reaction', r.users.includes(userId ?? '') && 'is-mine')} onClick={onAct}
                aria-label={t('messages.reactions.label', { emoji: r.emoji, count: r.users.length, names: f.list(r.users.map((u) => (u === userId ? t('messages.you') : nameOf(u)))) })}>
                <span aria-hidden>{r.emoji}</span>{r.users.length > 1 ? <span aria-hidden>{f.number(r.users.length)}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {last || seen || l.row.edited_at ? (
          <div className="k-chat-meta">
            {last || seen ? <time dateTime={l.at}>{time}</time> : null}
            {l.row.edited_at ? <span className="k-eph-edited">{t('edit.edited')}</span> : null}
            {seen && receiptsOn ? (
              <span className="k-chat-seen">
                <ChatIcon name="doubleCheck" size={14} />
                {seen.length === 0 ? t('messages.receipt.sent') : isGroup ? t('messages.receipt.seenBy', { count: seen.length }) : t('messages.receipt.seen')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
