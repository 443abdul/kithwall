'use client';
// "Birthdays" on Home: connections whose birthday is today or in the next few days, worked out on this
// device from their (decrypted) profiles. Nothing is asked of the server; people who hide their birthday,
// or share it only with others, never appear.
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { myFriendIds } from '@/lib/friends';
import { useSession } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { daysUntilBirthday } from '@/lib/social/profile';

const AHEAD = 7;

export function Birthdays() {
  const t = useT();
  const { status } = useSession();
  usePeopleVersion();
  const q = useQuery({
    queryKey: ['friend-ids'], enabled: status === 'ready', staleTime: 5 * 60_000,
    queryFn: async () => { const ids = await myFriendIds(); await people.ensure(ids); return ids; },
  });
  const soon = (q.data ?? [])
    .map((id) => ({ id, days: daysUntilBirthday(people.person(id)?.info) }))
    .filter((x): x is { id: string; days: number } => x.days !== null && x.days <= AHEAD)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);
  if (!soon.length) return null;
  return (
    <Card className="k-bdays" role="region" aria-label={t('bday.title')}>
      <h2 className="k-bdays-title"><Icon name="gift" /> {t('bday.title')}</h2>
      <ul className="k-bdays-list" role="list">
        {soon.map((x) => <li key={x.id}><Row id={x.id} days={x.days} /></li>)}
      </ul>
    </Card>
  );
}

function Row({ id, days }: { id: string; days: number }) {
  const t = useT();
  const p = usePerson(id);
  const avatar = useFileUrl(p?.info?.avatar?.thumb);
  if (!p) return null;
  return (
    <Link href={`/u/${p.username}`} className="k-bdays-row">
      <Avatar name={p.name} src={avatar} size={36} />
      <span className="k-bdays-name">{p.name}</span>
      <span className="k-small k-muted">{days === 0 ? t('bday.today') : t('bday.inDays', { count: days })}</span>
    </Link>
  );
}
