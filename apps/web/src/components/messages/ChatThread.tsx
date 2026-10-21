'use client';
// One chat (Kithwall 2): header, the conversation as bubbles (day separators, runs, replies, photos,
// videos, link cards, reactions), optimistic sending, optional typing and read receipts, composer.
// Phase 3: disappearing messages (timer in the header, expired messages leave the screen at once, timer
// notices inline, a one-time suggestion in older chats), edits ("edited") and live unsend.
import { VerifiedBadge } from '@/lib/transparency/verified';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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

interface Line extends ChatLine { row: MessageRow; payload: ChatPayload | null }
interface Pending { tempId: string; draft: Draft; status: 'sending' | 'failed'; progress: number; error?: string }

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
  const [pending, setPending] = useState<Pending[]>([]);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [acting, setActing] = useState<Line | null>(null);
  const [info, setInfo] = useState<false | 'main' | 'timer'>(false);
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
    return { id: row.id, sender: row.sender_id, at: row.created_at, event: d.ok && !!d.value.event, row, payload: d.ok ? d.value : null };
    // kv / pv: re-read when keys or people arrive ("waiting for a key" results are not cached)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [msgs.rows, c, kv, pv]);
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const items = useMemo(() => buildThread(lines), [lines]);
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

  const send = useCallback((draft: Draft) => {
    const tempId = crypto.randomUUID();
    setReply(null);
    setAtBottom(true);
    setPending((p) => [...p, { tempId, draft, status: 'sending', progress: 0 }]);
    const run = async () => {
      try {
        await sendDraft(c, draft, (x) => setPending((p) => p.map((q) => (q.tempId === tempId ? { ...q, progress: x } : q))));
        await qc.invalidateQueries({ queryKey: ['messages', c.id] });
        setPending((p) => p.filter((q) => q.tempId !== tempId));
        void qc.invalidateQueries({ queryKey: ['conversations'] });
      } catch (e) {
        const code = e instanceof SendError ? e.code : 'failed';
        setPending((p) => p.map((q) => (q.tempId === tempId ? { ...q, status: 'failed', error: t(`messages.error.${code}` as MessageKey) } : q)));
      }
    };
    void run();
  }, [c, qc, t]);

  const retry = (p: Pending) => { setPending((xs) => xs.filter((q) => q.tempId !== p.tempId)); send(p.draft); };
  const discard = (p: Pending) => setPending((xs) => xs.filter((q) => q.tempId !== p.tempId));

  const startReply = (l: Line) => {
    setReply({ id: l.id, author: l.sender, authorName: l.sender === userId ? t('messages.you') : nameOf(l.sender), text: l.payload?.text ?? previewText({ ok: true, value: l.payload ?? { text: '' } }, t) });
    setFocusKey((k) => k + 1);
  };

  const jumpTo = (mid: string) => {
    const el = document.getElementById(`m-${mid}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1400);
  };

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
            <span className="k-chat-head-title">{title}{!isGroup && others.length === 1 ? <> <VerifiedBadge userId={others[0]} /></> : null}</span>
            <span className={cx('k-chat-head-sub', typing.length > 0 && 'is-typing')} aria-live="polite">
              {!typing.length && c.disappear_secs
                ? <><span className="k-eph-sub-base">{subtitle}</span><span className="k-eph-sep" aria-hidden> · </span><TimerHint secs={c.disappear_secs} /></>
                : subtitle}
            </span>
          </span>
        </button>
        <CallButtons conversation={c} />
        <IconButton icon="clock" label={t('ephemeral.chat.title')} onClick={() => setInfo('timer')} className={c.disappear_secs ? 'k-eph-headbtn is-on' : 'k-eph-headbtn'} />
        <IconButton icon="info" label={t('messages.info.title')} onClick={() => setInfo('main')} />
      </header>

      <div ref={scroller} className="k-chat-scroll" onScroll={onScroll} role="log" aria-label={t('messages.threadLabel', { title })} aria-live="polite" aria-relevant="additions">
        <div className="k-chat-sealed k-small"><Icon name="lock" /> {t('messages.sealedBanner')}</div>
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
            if (it.kind === 'event') {
              const actor = l.sender === userId ? t('messages.you') : nameOf(l.sender);
              const txt = l.payload ? eventLine(l.payload, actor, nameOf, list, t) : null;
              return txt ? <li key={it.key} className="k-chat-event" id={`m-${l.id}`}>{txt}</li> : null;
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
          {pending.map((p) => (
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
                      <span className="k-chat-failed" role="alert">
                        <Icon name="alert" /> {p.error}
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
      <ChatComposer convId={c.id} members={c.members} disabled={disabled} reply={reply} onCancelReply={() => setReply(null)} onSend={send} focusKey={focusKey} />

      {acting ? (
        <MessageActions c={c} line={acting} mine={acting.sender === userId}
          myReaction={(reactionsOf.get(acting.id) ?? []).find((r) => r.userId === userId)?.emoji ?? null}
          onReply={() => { const l = acting; setActing(null); startReply(l); }}
          onClose={() => setActing(null)} />
      ) : null}
      <ChatInfo c={c} open={!!info} initialStep={info || 'main'} onClose={() => setInfo(false)} title={title} />
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
            {d.ok ? (
              <>
                {voice ? <VoiceNote file={voice.file} meta={voice.meta} messageId={l.id} mine={mine} /> : null}
                {p?.attachments?.length ? <ChatAttachments files={p.attachments} /> : null}
                {text ? <p className="k-chat-text" dir="auto"><MessageText text={text} /></p> : null}
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
