'use client';
// Search inside one chat (lib/search): a field under the chat's header and the messages of this chat that
// contain the words; choosing one jumps to it in the thread. On this device only.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { ConversationSummary } from '@/lib/messages';
import type { SearchHit } from '@/lib/search';
import { useSearch, useSearchEnabled } from '@/lib/search/hooks';
import { IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { MessageResults } from './Results';

export function ChatSearch({ c, onPick, onClose }: { c: ConversationSummary; onPick: (hit: SearchHit) => void; onClose: () => void }) {
  const t = useT();
  const enabled = useSearchEnabled();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const { hits, searching } = useSearch(query, { kinds: ['message'], ctx: c.id, limit: 60 });
  useEffect(() => { input.current?.focus(); }, []);
  const typed = query.trim().length >= 2;
  return (
    <div className="k-chat-find" role="search" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="k-chat-find-bar">
        <div className="k-chat-search">
          <label className="k-sr-only" htmlFor={`k-chat-find-${c.id}`}>{t('search.inChat')}</label>
          <Icon name="search" />
          <input ref={input} id={`k-chat-find-${c.id}`} type="search" className="k-input" placeholder={t('search.inChat')} value={query}
            onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} enterKeyHint="search" />
        </div>
        <IconButton icon="close" label={t('search.close')} onClick={onClose} />
      </div>
      {!enabled ? (
        <p className="k-small k-muted k-chat-search-note">{t('search.off')} <Link href="/you/settings/data#search">{t('search.offLink')}</Link></p>
      ) : typed ? (
        <div className="k-chat-find-results">
          {searching ? <div className="k-center"><Spinner /></div>
            : hits.length ? (
              <>
                <p className="k-small k-muted k-chat-search-note" role="status">{t('search.count', { count: hits.length })}</p>
                <MessageResults hits={hits} conversations={[c]} inChat label={t('search.inChat')}
                  onPick={(h) => { onPick(h); onClose(); }} />
              </>
            ) : <p className="k-small k-muted k-chat-search-note" role="status">{t('search.noMessages')}</p>}
          <p className="k-small k-muted k-chat-search-note">{t('search.onDevice')} <Link href="/you/settings/data#search">{t('search.older')}</Link></p>
        </div>
      ) : null}
    </div>
  );
}
