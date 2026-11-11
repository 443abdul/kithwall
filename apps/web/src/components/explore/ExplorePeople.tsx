'use client';
// Explore → People (docs/v2/10-follow-public.md §5): search by name or @handle, which only ever returns
// accounts that let people follow them, and Suggested accounts, worked out on this device from who my
// connections follow (lib/follow/suggest). Rows show what the server shows about an account (public name and
// handle); nobody is added to my people directory until I open their profile.
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button, IconButton } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { TextField } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { follow, myFollowingIds, searchAccounts, unfollow, type AccountCard, type SearchHit } from '@/lib/follow/follow';
import { rankSuggestions, type FollowEdge } from '@/lib/follow/suggest';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { dismissSuggestion, useHiddenStore } from '@/lib/social/hiddenStore';
import { isMuted, useSocialPrefs } from '@/lib/social/prefs';
import { sb, must } from '@/lib/supabase';

/** A follow-enabled account in a list: public name, @handle, a line of context and a Follow button. */
export function AccountRow({ account, sub, following, trailing }: { account: AccountCard; sub?: ReactNode; following: boolean; trailing?: ReactNode }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);
  const name = account.name?.trim() || `@${account.username}`;
  async function toggle() {
    setBusy(true);
    try {
      if (on) await unfollow(account.id); else await follow(account.id);
      setOn(!on);
      toast({ message: t(on ? 'follow.unfollowed' : 'follow.followed', { name }) });
      void qc.invalidateQueries({ queryKey: ['follows'] });
      void qc.invalidateQueries({ queryKey: ['v2feed'] });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(false); }
  }
  return (
    <div className="k-item k-person-row">
      <Link href={`/u/${account.username}`} className="k-person-link">
        <span className="k-item-lead"><Avatar name={name} size={44} /></span>
        <span className="k-item-body">
          <span className="k-item-title">{name}</span>
          <span className="k-item-sub"><span className="k-ltr">@{account.username}</span>{sub ? <> · {sub}</> : null}</span>
        </span>
      </Link>
      <span className="k-item-trail k-row">
        <Button size="sm" variant={on ? 'secondary' : 'primary'} icon={on ? 'userCheck' : 'plus'} busy={busy} onClick={() => void toggle()}>
          {on ? t('follow.following') : t('follow.follow')}
        </Button>
        {trailing}
      </span>
    </div>
  );
}

function Search() {
  const t = useT();
  const [value, setValue] = useState('');
  const [asked, setAsked] = useState('');
  const q = useQuery({ queryKey: ['follows', 'search', asked], enabled: asked.length >= 2, staleTime: 60_000, queryFn: () => searchAccounts(asked) });
  function submit(e: FormEvent) {
    e.preventDefault();
    setAsked(value.trim().replace(/^@+/, '').slice(0, 60));
  }
  const hits: SearchHit[] = q.data ?? [];
  return (
    <section className="k-stack-sm" aria-labelledby="explore-search-h">
      <h2 id="explore-search-h" className="k-section-title">{t('explore.search.title')}</h2>
      <Card>
        <form className="k-people-search" role="search" onSubmit={submit}>
          <TextField label={t('explore.search.label')} value={value} autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="auto"
            hint={t('explore.search.hint')} maxLength={60} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" variant="primary" icon="search" busy={q.isFetching} disabled={value.trim().replace(/^@+/, '').length < 2}>{t('people.search')}</Button>
        </form>
      </Card>
      {asked.length >= 2 && q.isFetched ? (
        hits.length ? (
          <Card padding="flush">
            <ul className="k-list" role="list">
              {hits.map((h) => <li key={h.id}><AccountRow account={h} following={h.iFollow} sub={t('follow.count', { count: h.followers })} /></li>)}
            </ul>
          </Card>
        ) : <p className="k-muted k-small" role="status">{t('explore.search.none', { query: asked })}</p>
      ) : null}
      {q.isError ? <p className="k-error" role="alert">{t('errors.network')}</p> : null}
      <p className="k-xs k-muted">{t('explore.search.note')}</p>
    </section>
  );
}

function Suggested() {
  const t = useT();
  const { userId, status } = useSession();
  usePeopleVersion();
  const friends = useFriendIds();
  const hidden = useHiddenStore();
  const prefs = useSocialPrefs();
  const edges = useQuery({
    queryKey: ['follows', 'suggest-edges'], enabled: status === 'ready', staleTime: 5 * 60_000,
    queryFn: async () => (must(await sb().rpc('connections_following')) ?? []) as FollowEdge[],
  });
  const mine = useQuery({ queryKey: ['follows', 'following-ids'], enabled: status === 'ready', staleTime: 60_000, queryFn: myFollowingIds });
  if (edges.isPending || mine.isPending || friends.isPending || !hidden.loaded) return <Skeleton height={64} />;
  const list = rankSuggestions(edges.data ?? [], {
    me: userId ?? '', known: [...(mine.data ?? []), ...(friends.data ?? [])],
    hidden: [...hidden.dismissed, ...Object.keys(prefs.muted).filter((id) => isMuted(prefs.muted, id))], limit: 12,
  });
  if (!list.length) {
    return <Card><EmptyState icon="users" title={t('explore.suggest.emptyTitle')} body={t('explore.suggest.emptyBody')} headingLevel={3} /></Card>;
  }
  const nameOf = (id: string) => people.person(id)?.name ?? '';
  return (
    <Card padding="flush">
      <ul className="k-list" role="list">
        {list.map((s) => {
          const first = nameOf(s.via[0]!);
          const sub = first
            ? (s.via.length > 1 ? t('explore.suggest.viaMore', { name: first, count: s.via.length - 1 }) : t('explore.suggest.via', { name: first }))
            : t('explore.suggest.viaCount', { count: s.via.length });
          return (
            <li key={s.id}>
              <AccountRow account={s} following={false} sub={sub}
                trailing={<IconButton icon="close" size="sm" label={t('explore.suggest.dismiss', { name: s.name ?? s.username })} onClick={() => void dismissSuggestion(s.id).catch(() => undefined)} />} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function ExplorePeople() {
  const t = useT();
  return (
    <div className="k-stack">
      <Search />
      <section className="k-stack-sm" aria-labelledby="explore-suggest-h">
        <h2 id="explore-suggest-h" className="k-section-title">{t('explore.suggest.title')}</h2>
        <p className="k-muted k-small">{t('explore.suggest.body')}</p>
        <Suggested />
      </section>
    </div>
  );
}
