'use client';
// A conversation (Nov 2010 Messages thread): all messages oldest → newest with day separators,
// the reply box at the bottom, and the people / options box in the right column.
import Link from 'next/link';
import { Fragment, useEffect, useRef } from 'react';
import { AppPage, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion } from '@/lib/people';
import { longDate } from '@/lib/format';
import { conversationTitle, type ConversationSummary } from '@/lib/messages';
import { useConversation, useMarkRead, useMessages, useTyping } from '@/lib/chat/hooks';
import { live, rekeyWhereNeeded } from '@/lib/chat/live';
import { MessageItem, nameOf } from './MessageItem';
import { Composer } from './Composer';
import { ConversationPanel } from './ConversationPanel';
import '@/styles/messages.css';

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return longDate(d);
}

export function typingText(ids: string[]): string | null {
  if (!ids.length) return null;
  const first = (id: string) => nameOf(id).split(' ')[0];
  if (ids.length === 1) return `${first(ids[0]!)} is typing…`;
  if (ids.length === 2) return `${first(ids[0]!)} and ${first(ids[1]!)} are typing…`;
  return 'Several people are typing…';
}

export function Thread({ id }: { id: string }) {
  const { userId } = useSession();
  const conv = useConversation(id);
  const c = conv.data ?? null;
  const msgs = useMessages(c ? id : null);
  const typing = useTyping(id);
  usePeopleVersion();
  useKeyringVersion();
  useMarkRead(c, true);
  const bottom = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);
  const count = msgs.rows.length;
  const newest = msgs.rows[count - 1]?.id;

  useEffect(() => { live.setViewing(id); return () => live.setViewing(null); }, [id]);
  useEffect(() => { if (c) rekeyWhereNeeded([c]); }, [c]);
  useEffect(() => {
    if (!count) return;
    const el = bottom.current;
    if (!el) return;
    const near = window.innerHeight + window.scrollY > document.body.scrollHeight - 400;
    if (firstScroll.current || near) { el.scrollIntoView({ block: 'end' }); firstScroll.current = false; }
  }, [newest, count]);

  if (conv.isLoading) return <AppPage active="messages"><div className="gray kwm-pad">Loading…</div></AppPage>;
  if (!c) {
    return (
      <AppPage active="messages">
        <Title icon="msg" right={<Link href="/messages">&laquo; Back to Messages</Link>}>Messages</Title>
        <div className="note">{conv.isError ? 'This conversation couldn’t be loaded.' : 'This conversation doesn’t exist, or you’re no longer in it.'}</div>
      </AppPage>
    );
  }

  const others = c.members.filter((m) => m !== userId);
  const title = conversationTitle(c, nameOf);
  const heading = c.isDm || !others.length ? `Between You and ${title}` : title;
  const tt = typingText(typing);

  return (
    <AppPage active="messages" right={<ConversationPanel conv={c} />}>
      <Title icon="msg" right={<Link href="/messages" className="kwm-back">&laquo; Back to Messages</Link>}>
        <span className="kwm-title">{heading}</span>
      </Title>
      <div className="kwm-secure gray"><Icon name="lock" /> End-to-end encrypted{c.isDm ? '' : ` · ${c.members.length} people`}</div>
      {msgs.hasOlder && (
        <div className="kwm-more">
          <button type="button" className="btn" disabled={msgs.isFetchingNextPage} onClick={() => void msgs.loadOlder()}>
            {msgs.isFetchingNextPage ? 'Loading…' : 'Show Older Messages'}
          </button>
        </div>
      )}
      {msgs.isLoading && <div className="gray kwm-pad">Loading messages…</div>}
      {msgs.isError && <div className="err" role="alert">Messages couldn&rsquo;t be loaded.</div>}
      <div className="kwm-thread" aria-live="polite" aria-relevant="additions">
        {msgs.rows.map((m, i) => {
          const prev = msgs.rows[i - 1];
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
          return (
            <Fragment key={m.id}>
              {newDay && <div className="kwm-day"><span>{dayLabel(m.created_at)}</span></div>}
              <MessageItem conv={c} row={m} />
            </Fragment>
          );
        })}
        {!msgs.isLoading && !count && <div className="gray kwm-pad">No messages yet. Say hi!</div>}
      </div>
      <div className="kwm-typing gray" aria-live="polite">{tt ?? ' '}</div>
      <Composer conv={c} members={c.members} disabled={others.length ? null : 'Everyone else has left this conversation.'} />
      <div ref={bottom} />
    </AppPage>
  );
}

export type { ConversationSummary };
