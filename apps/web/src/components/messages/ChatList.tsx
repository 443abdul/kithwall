'use client';
// Kithwall 2 conversation list: search (over decrypted names and previews, on this device), pinned
// chats first, unread state, archive. The list lives in the Messages layout, beside the open chat on
// wide screens and on its own on phones.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormat, useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { useKeyringVersion } from '@/lib/hooks';
import { usePeopleVersion } from '@/lib/people';
import { listConversations, readMessage, type ConversationSummary } from '@/lib/messages';
import { isArchived, useMessagesPrefs } from '@/lib/chat/prefs';
import { rekeyWhereNeeded } from '@/lib/chat/live';
import { useHiddenChats } from '@/lib/safety/hidden';
import { Icon } from '@/components/ui/Icon';
import { ButtonLink, IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Callout } from '@/components/ui/Callout';
import { cx } from '@/components/ui/cx';
import { dayBucket, matches, orderConversations } from './chatModel';
import { ConversationAvatar, useConversationTitle, useNameOf } from './look';
import { previewText } from './content';
import { ChatIcon } from './ChatIcon';

export function useConversationList() {
  const { status } = useSession();
  return useQuery({
    queryKey: ['conversations', 'v2'], enabled: status === 'ready',
    queryFn: async () => { const xs = await listConversations(100); rekeyWhereNeeded(xs); return xs; },
  });
}

function useTimeLabel() {
  const f = useFormat();
  const t = useT();
  return (iso: string) => {
    const b = dayBucket(iso);
    const d = new Date(iso);
    if (b === 'today') return f.date(d, { timeStyle: 'short' });
    if (b === 'yesterday') return t('messages.yesterday');
    if (b === 'week') return f.date(d, { weekday: 'short' });
    return f.date(d, { day: 'numeric', month: 'short' });
  };
}

function Row({ c, active, pinned, filter }: { c: ConversationSummary; active: boolean; pinned: boolean; filter: string }) {
  const t = useT();
  const { userId } = useSession();
  const title = useConversationTitle(c);
  const nameOf = useNameOf();
  const when = useTimeLabel();
  let preview = '';
  if (c.last) {
    const d = readMessage(c, c.last);
    const body = d.ok && d.value.event ? t('messages.preview.event') : previewText(d, t);
    preview = c.last.sender_id === userId ? t('messages.preview.you', { text: body })
      : c.isDm || c.members.length <= 2 ? body : t('messages.preview.from', { name: nameOf(c.last.sender_id).split(' ')[0] ?? '', text: body });
  } else preview = t('messages.preview.empty');
  if (!matches(filter, title, preview)) return null;
  return (
    <li>
      <Link href={`/messages/${c.id}`} className={cx('k-chat-row', c.unread && 'is-unread')} aria-current={active ? 'page' : undefined}>
        <ConversationAvatar c={c} size={48} />
        <span className="k-chat-row-body">
          <span className="k-chat-row-top">
            <span className="k-chat-row-title">{title}</span>
            {c.disappear_secs ? <span className="k-eph-rowico" title={t('ephemeral.chat.title')}><Icon name="clock" /></span> : null}
            <time className="k-chat-row-time" dateTime={c.last?.created_at ?? c.last_message_at}>{when(c.last?.created_at ?? c.last_message_at)}</time>
          </span>
          <span className="k-chat-row-bottom">
            <span className="k-chat-row-preview">{preview}</span>
            {pinned ? <span className="k-chat-row-pin" title={t('messages.pinned')}><ChatIcon name="pin" size={16} /></span> : null}
            {c.unread ? <span className="k-chat-row-dot" role="img" aria-label={t('messages.unread')} /> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function ConversationListPane({ activeId }: { activeId: string | null }) {
  const t = useT();
  usePeopleVersion();
  useKeyringVersion();
  const q = useConversationList();
  const prefs = useMessagesPrefs();
  // Chats hidden behind the app PIN (Safety centre) are left out until revealed.
  const hiddenChats = useHiddenChats();
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const { visible, archived } = useMemo(() => {
    const all = (q.data ?? []).filter((c) => !hiddenChats.has(c.id));
    const p = prefs.data;
    const entries = all.map((c) => ({ c, id: c.id, lastAt: c.last?.created_at ?? c.last_message_at, pinnedAt: p?.pinned?.[c.id] ?? null }));
    const arch = entries.filter((e) => isArchived(p, e.id, e.lastAt) && !e.pinnedAt);
    const vis = entries.filter((e) => !arch.includes(e));
    return { visible: orderConversations(vis), archived: orderConversations(arch) };
  }, [q.data, prefs.data, hiddenChats]);

  const shown = showArchived ? archived : visible;
  const unread = visible.filter((e) => e.c.unread).length;

  return (
    <div className="k-chat-list">
      <header className="k-chat-list-head">
        <div className="k-chat-list-titles">
          <h1>{showArchived ? t('messages.archived') : t('nav.messages')}</h1>
          <p className="k-muted k-small"><Icon name="lock" /> {unread ? t('common.unread', { count: unread }) : t('messages.sealedNote')}</p>
        </div>
        {showArchived
          ? <IconButton icon="back" label={t('common.back')} onClick={() => setShowArchived(false)} />
          : <ButtonLink href="/messages/new" variant="primary" size="sm" icon="plus" aria-label={t('messages.newChat')}><span className="k-chat-hide-sm">{t('messages.new')}</span></ButtonLink>}
      </header>
      <div className="k-chat-search">
        <label className="k-sr-only" htmlFor="k-chat-search">{t('messages.search')}</label>
        <Icon name="search" />
        <input id="k-chat-search" type="search" className="k-input" placeholder={t('messages.search')} value={filter}
          onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {q.isError ? <Callout tone="danger">{t('messages.loadFailed')}</Callout> : null}
      {q.isLoading ? (
        <ul className="k-chat-rows" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="k-chat-row k-chat-row-skel"><Skeleton circle width={48} height={48} /><span className="k-chat-row-body"><Skeleton text width="45%" /><Skeleton text width="75%" /></span></li>
          ))}
        </ul>
      ) : shown.length ? (
        <ul className="k-chat-rows" aria-label={t('messages.listLabel')}>
          {shown.map((e) => <Row key={e.id} c={e.c} active={e.id === activeId} pinned={!!e.pinnedAt} filter={filter} />)}
        </ul>
      ) : !q.isError ? (
        <EmptyState icon="sealed" title={t('messages.emptyTitle')} body={t('messages.emptyBody')}
          actions={<ButtonLink href="/messages/new" variant="primary" icon="plus">{t('messages.newChat')}</ButtonLink>} />
      ) : null}
      {!showArchived && archived.length ? (
        <button type="button" className="k-chat-archived-link" onClick={() => setShowArchived(true)}>
          <ChatIcon name="archive" /> {t('messages.archivedCount', { count: archived.length })}
        </button>
      ) : null}
      {filter && shown.length > 0 ? <p className="k-small k-muted k-chat-search-note">{t('messages.searchNote')}</p> : null}
    </div>
  );
}
