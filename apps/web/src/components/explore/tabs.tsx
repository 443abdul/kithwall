'use client';
// The tabs of Explore (docs/v2/10-follow-public.md §5). THE SEAM for further public feeds: add an entry here
// (and its label to the message catalogue) and it appears in Explore. A feed of one kind of public post needs
// no new data code: render <PublicFeed query={{ kinds: ['video'] }} label=… />, or read pages yourself with
// usePublicPosts(query) / fetchPublicPosts(query, cursor) from lib/public/posts.
import { useState, type ReactNode } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Segmented } from '@/components/ui/Segmented';
import type { IconName } from '@/components/ui/Icon';
import type { PublicSort } from '@/lib/public/posts';
import { ExplorePeople } from './ExplorePeople';
import { PublicFeed } from './PublicFeed';

export interface ExploreTab {
  /** Also the ?tab= value in the address. */
  value: string;
  label: MessageKey;
  icon: IconName;
  render: () => ReactNode;
}

/** Public posts from everyone: popular (public likes, comments and age only) or newest first. */
function ExplorePosts() {
  const t = useT();
  const [sort, setSort] = useState<PublicSort>('popular');
  return (
    <div className="k-stack">
      <Segmented<PublicSort> label={t('explore.sort')} value={sort} onChange={setSort} options={[
        { value: 'popular', label: t('explore.popular') },
        { value: 'recent', label: t('explore.recent') },
      ]} />
      <PublicFeed key={sort} query={{ sort }} label={t(sort === 'popular' ? 'explore.popular' : 'explore.recent')} />
      <p className="k-xs k-muted k-center">{t('explore.rankNote')}</p>
    </div>
  );
}

export const EXPLORE_TABS: ExploreTab[] = [
  { value: 'posts', label: 'explore.tab.posts', icon: 'globe', render: () => <ExplorePosts /> },
  { value: 'people', label: 'explore.tab.people', icon: 'users', render: () => <ExplorePeople /> },
];
