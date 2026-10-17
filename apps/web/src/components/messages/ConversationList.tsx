'use client';
// Messages inbox (Nov 2010 "new Messages"): one row per conversation with the newest message,
// decrypted on this device. Search runs over names and the decrypted snippets, locally.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AppPage, Title } from '@/components/Shell';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { usePeopleVersion } from '@/lib/people';
import { when } from '@/lib/format';
import { conversationTitle, listConversations, readMessage, type ConversationSummary } from '@/lib/messages';
import { isArchived, useMessagesPrefs, useSetArchived } from '@/lib/chat/prefs';
import { eventText, nameOf } from './MessageItem';
import '@/styles/messages.css';

export function snippetOf(c: ConversationSummary, me: string | null): { text: string; mine: boolean; locked: boolean } {
  if (!c.last) return { text: 'No messages yet.', mine: false, locked: false };
  const d = readMessage(c, c.last);
  const mine = c.last.sender_id === me;
  if (!d.ok) return { text: d.reason === 'unverified' ? 'This item couldn’t be verified.' : 'Encrypted message', mine, locked: true };
  const ev = eventText(d.value, nameOf);
  if (ev) return { text: `${nameOf(c.last.sender_id)} ${ev}`, mine: false, locked: false };
  const text = d.value.text?.replace(/\s+/g, ' ').trim();
  const n = d.value.attachments?.length ?? 0;
  return { text: text || (n ? (n === 1 ? 'Sent a photo.' : `Sent ${n} photos.`) : ''), mine, locked: false };
}

export function GroupAvatar({ c, me, size = 50 }: { c: ConversationSummary; me: string | null; size?: number }) {
  const others = c.members.filter((m) => m !== me);
  if (others.length <= 1) return others[0] ? <Avatar id={others[0]} size={size} /> : <Avatar id={me ?? ''} size={size} />;
  const half = Math.floor(size / 2);
  return (
    <span className="kwm-gav" style={{ width: size, height: size }} aria-hidden>
      {others.slice(0, 4).map((o) => <Avatar key={o} id={o} size={others.length > 2 ? half : size} />)}
    </span>
  );
}

export function ConversationList() {
  const { userId, status } = useSession();
  const [limit, setLimit] = useState(50);
  const convs = useQuery({ queryKey: ['conversations', 'page', limit], enabled: status === 'ready', queryFn: () => listConversations(limit), placeholderData: keepPreviousData });
  const prefs = useMessagesPrefs();
  const setArchived = useSetArchived();
  usePeopleVersion();
  useKeyringVersion();
  const [tab, setTab] = useState<'inbox' | 'archived'>('inbox');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (convs.data ?? [])
      .filter((c) => (tab === 'archived') === isArchived(prefs.data, c.id, c.last_message_at))
      .map((c) => ({ c, title: conversationTitle(c, nameOf), snip: snippetOf(c, userId) }))
      .filter((r) => !term || r.title.toLowerCase().includes(term) || (!r.snip.locked && r.snip.text.toLowerCase().includes(term)));
  }, [convs.data, prefs.data, tab, q, userId]);

  const archive = async (id: string, on: boolean) => {
    setErr(null);
    try { await setArchived(id, on); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <AppPage active="messages" right={<MessagesRight />}>
      <Title icon="msg" right={<Link className="btn" href="/messages/new">+ New Message</Link>}>Messages</Title>
      <div className="kwm-tools">
        <div className="tabs2" role="tablist">
          <a role="tab" aria-selected={tab === 'inbox'} className={tab === 'inbox' ? 'on' : ''} href="#" onClick={(e) => { e.preventDefault(); setTab('inbox'); }}>Inbox</a>
          <a role="tab" aria-selected={tab === 'archived'} className={tab === 'archived' ? 'on' : ''} href="#" onClick={(e) => { e.preventDefault(); setTab('archived'); }}>Archived</a>
        </div>
        <input type="search" className="kwm-search" placeholder="Search messages" aria-label="Search messages" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {prefs.isError && <div className="kwm-state">Archived conversations couldn&rsquo;t be loaded on this device.</div>}
      {convs.isLoading && <div className="gray kwm-pad">Loading…</div>}
      {convs.isError && <div className="err" role="alert">Messages couldn&rsquo;t be loaded. {(convs.error as Error).message}</div>}
      <div className="kwm-list">
        {rows.map(({ c, title, snip }) => (
          <div key={c.id} className={`thr kwm-row${c.unread ? ' un' : ''}`}>
            <Link className="kwm-rowlink" href={`/messages/${c.id}`} aria-label={`${title}${c.unread ? ' (unread)' : ''}`}>
              <GroupAvatar c={c} me={userId} />
              <div className="kwm-tbody">
                <b className="kwm-tname">{title}</b>
                <div className="kwm-snip">{snip.mine ? <span className="gray">&#8617; </span> : null}{snip.locked ? <><Icon name="lock" /> </> : null}{snip.text}</div>
              </div>
              <div className="gray kwm-when">{when(c.last?.created_at ?? c.last_message_at)}</div>
            </Link>
            <button type="button" className="kwm-x" title={tab === 'archived' ? 'Unarchive' : 'Archive'} aria-label={tab === 'archived' ? `Unarchive ${title}` : `Archive ${title}`}
              onClick={() => void archive(c.id, tab !== 'archived')}>
              {tab === 'archived' ? '↩' : '×'}
            </button>
          </div>
        ))}
        {!convs.isLoading && !rows.length && (
          <div className="gray kwm-pad">{q ? 'No conversations match your search.' : tab === 'archived' ? 'No archived conversations.' : 'No messages.'}</div>
        )}
      </div>
      {convs.data?.length === limit && (
        <div className="kwm-more"><button type="button" className="btn" onClick={() => setLimit(limit + 50)}>Show Older Conversations</button></div>
      )}
    </AppPage>
  );
}

export function MessagesRight() {
  return (
    <div className="rs">
      <div className="rh"><span>About Messages</span></div>
      <div className="kwm-about"><Icon name="lock" /> Messages and chats are end-to-end encrypted. Only the people in a conversation can read it &mdash; not even Kithwall.</div>
    </div>
  );
}
