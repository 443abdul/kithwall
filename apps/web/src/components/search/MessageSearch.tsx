'use client';
// Message search in the Messages list (lib/search): under the chats whose name matches, the messages that
// contain the words, across every chat this device has read. Runs on this device; the server never sees the
// query. Chats hidden behind the app PIN are left out unless they are revealed.
import Link from 'next/link';
import { useT } from '@/i18n';
import type { ConversationSummary } from '@/lib/messages';
import { useSearch, useSearchEnabled } from '@/lib/search/hooks';
import { Spinner } from '@/components/ui/Spinner';
import { MessageResults } from './Results';

export function MessageSearch({ query, conversations }: { query: string; conversations: readonly ConversationSummary[] }) {
  const t = useT();
  const enabled = useSearchEnabled();
  const { hits, searching } = useSearch(query, { kinds: ['message'], limit: 40 });
  if (query.trim().length < 2) return null;
  if (!enabled) {
    return <p className="k-small k-muted k-chat-search-note">{t('search.off')} <Link href="/you/settings/data#search">{t('search.offLink')}</Link></p>;
  }
  return (
    <section className="k-search-section" aria-labelledby="k-msg-search-h">
      <h2 id="k-msg-search-h" className="k-section-title">{t('search.messages')}</h2>
      {searching ? <div className="k-center"><Spinner /></div>
        : hits.length ? <MessageResults hits={hits} conversations={conversations} label={t('search.messages')} />
          : <p className="k-small k-muted k-chat-search-note" role="status">{t('search.noMessages')}</p>}
      <p className="k-small k-muted k-chat-search-note">
        {t('search.onDevice')} <Link href="/you/settings/data#search">{t('search.older')}</Link>
      </p>
    </section>
  );
}
