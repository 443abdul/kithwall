'use client';
// The safety screen under a connection request (and on a stranger's profile): how new the account is, how
// many of my connections know them (from my connections' own encrypted friend lists, worked out on this
// device), and a loud warning when their name or @handle imitates someone I'm already connected with
// (lib/social/lookalike). Spans only (it sits inside person rows that are links); nothing is asked of the
// server beyond what the app already loaded.
import { useQuery } from '@tanstack/react-query';
import { useFormat, useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { myFriendIds } from '@/lib/friends';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { lookalikeOf } from '@/lib/social/lookalike';

const NEW_ACCOUNT_DAYS = 14;

export function useConnectionIds() {
  const { status } = useSession();
  return useQuery({
    queryKey: ['friend-ids'], enabled: status === 'ready', staleTime: 5 * 60_000,
    queryFn: async () => { const ids = await myFriendIds(); await people.ensure(ids); return ids; },
  });
}

export function RequestSafety({ userId, compact = false }: { userId: string; compact?: boolean }) {
  const t = useT();
  const f = useFormat();
  usePeopleVersion();
  const friends = useConnectionIds();
  const ids = friends.data ?? [];
  if (!friends.data || ids.includes(userId)) return null;
  const p = people.person(userId);
  const row = people.get(userId);
  const mutual = ids.filter((id) => people.person(id)?.info?.friends?.includes(userId));
  const imitates = lookalikeOf({ id: userId, name: p?.name, username: p?.username },
    ids.map((id) => ({ id, name: people.person(id)?.name, username: people.person(id)?.username })));
  const ageDays = row?.created_at ? Math.floor((Date.now() - Date.parse(row.created_at)) / 86_400_000) : null;
  const isNew = ageDays !== null && ageDays < NEW_ACCOUNT_DAYS;
  const names = mutual.slice(0, 2).map((id) => people.person(id)?.name ?? '').filter(Boolean);
  return (
    <span className="k-req-safety" data-compact={compact ? '' : undefined}>
      {imitates ? (
        <span className="k-req-warn" role="alert">
          <Icon name="alert" />
          <span>{t('safety.req.lookalike', { name: people.person(imitates.id)?.name ?? '', handle: people.person(imitates.id)?.username ?? '' })}</span>
        </span>
      ) : null}
      <span className="k-req-facts k-small">
        {ageDays !== null ? (
          <span data-tone={isNew ? 'warn' : undefined}>
            <Icon name="clock" /> {isNew ? t('safety.req.newAccount', { count: Math.max(ageDays, 0) })
              : t('safety.req.joined', { date: f.date(new Date(row!.created_at), { month: 'short', year: 'numeric' }) })}
          </span>
        ) : null}
        <span data-tone={mutual.length ? 'ok' : 'warn'}>
          <Icon name="users" /> {mutual.length
            ? (names.length ? t('safety.req.mutualNamed', { names: names.join(', '), count: mutual.length }) : t('safety.req.mutual', { count: mutual.length }))
            : t('safety.req.noMutual')}
        </span>
      </span>
    </span>
  );
}
