'use client';
// One docked chat window (2010 `.cw`): header with name + online dot (orange when minimised with
// unread messages), the last 30 messages, "… is typing", and a one-line input (Enter sends).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AvatarLink } from '@/components/Avatar';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePerson, usePeopleVersion } from '@/lib/people';
import { conversationTitle, MAX_MESSAGE_CHARS, openDm, readMessage, type ConversationRow, type ConversationSummary } from '@/lib/messages';
import type { MessageRow } from '@/lib/types';
import { dock, type ChatWin } from '@/lib/chat/dock';
import { useConversation, useMarkRead, useMessages, useTyping } from '@/lib/chat/hooks';
import { signals, useSignalsVersion } from '@/lib/chat/signals';
import { MessageText } from './MessageText';
import { Attachment } from './Attachment';
import { eventText, nameOf, Undecryptable } from './MessageItem';
import { sendErrorText, sendWithAttachments } from './Composer';
import { typingText } from './Thread';

const first = (id: string) => nameOf(id).split(' ')[0];

function ChatLine({ conv, row }: { conv: ConversationSummary; row: MessageRow }) {
  const d = readMessage(conv, row);
  if (d.ok && d.value.event) {
    const t = eventText(d.value, nameOf);
    if (t) return <div className="cmi kwc-ev gray">{first(row.sender_id)} {t}</div>;
  }
  const beforeJoin = !d.ok && d.reason === 'waiting' && !!conv.joinedAt && row.created_at < conv.joinedAt;
  return (
    <div className="cmi">
      <AvatarLink id={row.sender_id} size={24} />
      <div className="cmb">
        <b>{first(row.sender_id)}</b>{' '}
        {d.ok ? (
          <>
            {d.value.text ? <MessageText text={d.value.text} /> : null}
            {d.value.attachments?.length ? <div className="kwm-atts">{d.value.attachments.slice(0, 6).map((a) => <Attachment key={a.path} file={a} small />)}</div> : null}
          </>
        ) : <Undecryptable d={d} senderId={row.sender_id} beforeJoin={beforeJoin} />}
      </div>
    </div>
  );
}

export function ChatWindow({ win }: { win: ChatWin }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const conv = useConversation(win.convId);
  const c = conv.data ?? null;
  const msgs = useMessages(c ? c.id : null);
  const typing = useTyping(win.convId);
  const other = win.userId ?? c?.members.find((m) => m !== userId) ?? null;
  const person = usePerson(other);
  usePeopleVersion();
  useKeyringVersion();
  useSignalsVersion();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const rows = msgs.rows.slice(-30);
  const newest = rows[rows.length - 1]?.id;

  useMarkRead(c, !win.min && (focused || (typeof document !== 'undefined' && document.hasFocus())));
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [newest, win.min, typing.length]);
  // The conversation was deleted or I left it: close the window.
  useEffect(() => { if (win.convId && conv.isSuccess && !conv.data) dock.close(win); }, [win, conv.isSuccess, conv.data]);

  const title = c ? (c.isDm && person ? person.name : conversationTitle(c, nameOf)) : person?.name ?? '…';
  const pres = other && (!c || c.isDm) ? signals.presenceOf(other) : null;
  const members = c?.members ?? (other && userId ? [userId, other] : []);
  const unread = !!c?.unread;

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null);
    try {
      let target: ConversationRow | null = c;
      if (!target) {
        if (!other) throw new Error('No one to send to.');
        target = await openDm(other);
        dock.attach(other, target.id);
      }
      signals.stopTyping(target.id, members);
      await sendWithAttachments(target, t, []);
      setText('');
      await qc.invalidateQueries({ queryKey: ['messages', target.id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (e) {
      setErr(sendErrorText(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <section className="cw" aria-label={`Chat with ${title}`}>
      <div className={`ch${win.min && unread ? ' new' : ''}`} role="button" tabIndex={0} aria-expanded={!win.min}
        onClick={() => dock.toggleMin(win)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); dock.toggleMin(win); } }}>
        <span className="kwc-title">{pres ? <span className={`dot${pres === 'idle' ? ' idle' : ''}`} /> : null}{pres ? ' ' : ''}{title}</span>
        <a role="button" tabIndex={0} title="Close" aria-label={`Close chat with ${title}`}
          onClick={(e) => { e.stopPropagation(); dock.close(win); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); dock.close(win); } }}>&times;</a>
      </div>
      {!win.min && (
        <>
          <div className="cb" ref={body} aria-live="polite">
            {c && rows.map((m) => <ChatLine key={m.id} conv={c} row={m} />)}
            {(!c || (!msgs.isLoading && !rows.length)) && <div className="gray">Start a conversation with {other ? first(other) : 'them'}.</div>}
            {msgs.isLoading && c && <div className="gray">Loading…</div>}
            {typing.length > 0 && <div className="gray kwc-typing">{typingText(typing)}</div>}
            {err && <div className="kwm-err" role="alert">{err}</div>}
          </div>
          <input ref={input} type="text" aria-label={`Message ${title}`} value={text} maxLength={MAX_MESSAGE_CHARS} disabled={busy}
            onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); if (c) signals.stopTyping(c.id, members); }}
            onChange={(e) => { setText(e.target.value); if (c) { if (e.target.value.trim()) signals.typing(c.id, members); else signals.stopTyping(c.id, members); } }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        </>
      )}
    </section>
  );
}
