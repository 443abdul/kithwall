'use client';
// All notifications (reference vNotifs), grouped by day. Previews are sealed to you and decrypted
// on this device.
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { Icon } from '@/components/Icon';
import { useNotifications } from '@/lib/hooks';
import { people, usePeopleVersion } from '@/lib/people';
import { markAllRead, markRead, notifHref, notifText, NOTIF_ICON, preview } from '@/lib/notifications';
import { clock, MONTHS } from '@/lib/format';
import type { NotificationRow } from '@/lib/types';
import '@/styles/social.css';

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === today.getFullYear() ? '' : `, ${d.getFullYear()}`}`;
}

function Notifications() {
  usePeopleVersion();
  const qc = useQueryClient();
  const [limit, setLimit] = useState(100);
  const q = useNotifications(limit);
  const rows = q.data ?? [];
  const unread = rows.some((n) => !n.read_at);
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const groups: [string, NotificationRow[]][] = [];
  for (const n of rows) {
    const d = dayLabel(n.created_at);
    if (!groups.length || groups[groups.length - 1]![0] !== d) groups.push([d, []]);
    groups[groups.length - 1]![1].push(n);
  }
  return (
    <>
      <Title icon="globe" right={unread ? <a role="button" tabIndex={0} onClick={() => void markAllRead().then(refresh)}
        onKeyDown={(e) => { if (e.key === 'Enter') void markAllRead().then(refresh); }}>Mark All as Read</a> : null}>Notifications</Title>
      {q.isLoading && <div className="gray">Loading…</div>}
      {q.isError && <div className="err" role="alert">Couldn&rsquo;t load notifications.</div>}
      {groups.map(([day, list]) => (
        <section key={day}>
          <div className="sub"><span>{day}</span></div>
          {list.map((n) => {
            const a = people.person(n.actor_id);
            const pv = preview(n);
            return (
              <Link key={n.id} className={`kw-notif${n.read_at ? '' : ' un'}`} href={notifHref(n, a?.username)}
                onClick={() => { if (!n.read_at) void markRead(n.id).then(refresh); }}>
                <Icon name={NOTIF_ICON[n.type] ?? 'globe'} />
                <span className="t"><b>{a?.name ?? 'Someone'}</b> {notifText(n.type)}{pv ? <> &ldquo;{pv}&rdquo;</> : null}</span>
                <span className="gray">{clock(new Date(n.created_at))}</span>
              </Link>
            );
          })}
        </section>
      ))}
      {!q.isLoading && !rows.length && <div className="gray kw-pad">You have no notifications.</div>}
      {rows.length >= limit && <div className="kw-older"><button type="button" className="kw-link" onClick={() => setLimit((l) => l + 100)}><b>Show Older Notifications</b></button></div>}
      <p className="gray small" style={{ marginTop: 10 }}>Notifications are kept for 90 days. Their previews are encrypted so only you can read them.</p>
    </>
  );
}

export default function Page() {
  return <AppPage right={<TipsBox />}><Notifications /></AppPage>;
}
