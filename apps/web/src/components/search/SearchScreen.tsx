'use client';
// Search on your phone (/you/search; lib/search, docs/v2/03-safety.md §14): one field over the posts,
// comments and messages this device has decrypted. The words never leave the device: there is no request
// to the server when you type. (Finding people by @handle is a different thing and lives on Connections.)
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { useSearch, useIndexSize, useSearchEnabled } from '@/lib/search/hooks';
import { Page } from '@/components/shell/AppShell';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import { Spinner } from '@/components/ui/Spinner';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { useConversationList } from '@/components/messages/ChatList';
import { MessageResults, PostResults } from './Results';

type Scope = 'posts' | 'messages';

export function SearchScreen() {
  const t = useT();
  const f = useFormat();
  const enabled = useSearchEnabled();
  const size = useIndexSize();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('posts');
  const input = useRef<HTMLInputElement>(null);
  const convs = useConversationList();
  const posts = useSearch(query, { kinds: ['post', 'comment'], limit: 60 });
  const messages = useSearch(query, { kinds: ['message'], limit: 60 });
  useDocumentTitle(t('search.title'));
  useEffect(() => { input.current?.focus(); }, []);
  const typed = query.trim().length >= 2;
  const shown = scope === 'posts' ? posts : messages;

  return (
    <Page title={t('search.title')} description={t('search.description')} back={{ href: '/you', label: t('nav.you') }}>
      {!enabled ? (
        <Card>
          <EmptyState icon="search" title={t('search.offTitle')} body={t('search.off')}
            actions={<ButtonLink href="/you/settings/data#search" variant="primary" icon="settings">{t('search.offLink')}</ButtonLink>} />
        </Card>
      ) : (
        <>
          <div className="k-chat-search k-search-field" role="search">
            <label className="k-sr-only" htmlFor="k-search-q">{t('search.placeholder')}</label>
            <Icon name="search" />
            <input ref={input} id="k-search-q" type="search" className="k-input" placeholder={t('search.placeholder')} value={query}
              onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} enterKeyHint="search" dir="auto" />
          </div>
          <Segmented block label={t('search.scope')} value={scope} onChange={setScope} options={[
            { value: 'posts', label: typed && !posts.searching ? t('search.postsCount', { count: posts.hits.length }) : t('search.posts') },
            { value: 'messages', label: typed && !messages.searching ? t('search.messagesCount', { count: messages.hits.length }) : t('search.messages') },
          ]} />
          {!typed ? (
            <Card>
              <EmptyState icon="lock" title={t('search.introTitle')} body={t('search.introBody')} />
            </Card>
          ) : shown.searching ? <div className="k-center"><Spinner /></div>
            : shown.hits.length ? (
              <Card padding="flush">
                {scope === 'posts'
                  ? <PostResults hits={posts.hits} label={t('search.posts')} />
                  : <MessageResults hits={messages.hits} conversations={convs.data ?? []} label={t('search.messages')} />}
              </Card>
            ) : (
              <Card><EmptyState icon="search" title={t('search.noneTitle')} body={t('search.noneBody')} /></Card>
            )}
          <p className="k-small k-muted" role="status">
            <Icon name="lock" /> {size === null ? t('search.onDevice') : t('search.onDeviceCount', { count: size, n: f.number(size) })}{' '}
            <Link href="/you/settings/data#search">{t('search.older')}</Link>
          </p>
        </>
      )}
    </Page>
  );
}
