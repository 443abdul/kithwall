'use client';
// Activity (Kithwall 2): notifications grouped by day and by what they're about, and connection
// requests with accept / decline. Previews ("Dan commented: …") are sealed to me and opened here.
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { b64u, openSealed, type Sealed } from '@kithwall/crypto';
import { useFormat, useT, type MessageKey, type TFunction } from '@/i18n';
import { identity, useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { useKeyringVersion, useNotifications, useRequests } from '@/lib/hooks';
import { markAllRead, markRead, preview } from '@/lib/notifications';
import { acceptFriend, ignoreRequest } from '@/lib/friends';
import { sb } from '@/lib/supabase';
import type { FriendshipRow, NotificationRow } from '@/lib/types';
import { Page } from '@/components/shell/AppShell';
import { Tabs } from '@/components/ui/Tabs';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/Skeleton';
import { Callout } from '@/components/ui/Callout';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { PersonAvatar } from '@/components/messages/look';
import { dayBucket } from '@/components/messages/chatModel';
import { ACTIVITY_TYPES, activityHref, activityIcon, groupActivity, type ActivityGroup } from './activityModel';

const KNOWN = new Set<string>(ACTIVITY_TYPES);

function actorsText(ids: string[], nameOf: (id: string) => string, t: TFunction): string {
  const [a, b] = ids;
  if (!a) return t('messages.someone');
  if (ids.length === 1) return nameOf(a);
  if (ids.length === 2) return t('activity.actors.two', { a: nameOf(a), b: nameOf(b!) });
  return t('activity.actors.many', { name: nameOf(a), count: ids.length - 1 });
}

/** Posts a notification points at, mapped to their circle (posts in a circle open the circle). */
function useCircleOfPosts(rows: NotificationRow[] | undefined) {
  const ids = [...new Set((rows ?? []).filter((r) => r.object_kind === 'post' && r.object_id).map((r) => r.object_id!))];
  const { status } = useSession();
  return useQuery({
    queryKey: ['activity', 'post-circles', ids.join(',')], enabled: status === 'ready' && ids.length > 0, staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await sb().from('posts').select('id, group_id').in('id', ids.slice(0, 200));
      return new Map(((data ?? []) as { id: string; group_id: string | null }[]).map((p) => [p.id, p.group_id]));
    },
  });
}

function useDay() {
  const t = useT();
  const f = useFormat();
  return (iso: string) => {
    const b = dayBucket(iso);
    if (b === 'today') return t('messages.today');
    if (b === 'yesterday') return t('messages.yesterday');
    if (b === 'week') return f.date(new Date(iso), { weekday: 'long' });
    return f.date(new Date(iso), { dateStyle: 'medium' });
  };
}

function Item({ g, href, onOpen }: { g: ActivityGroup; href: string | null; onOpen: (g: ActivityGroup) => void }) {
  const t = useT();
  const f = useFormat();
  usePeopleVersion();
  const nameOf = (id: string) => people.person(id)?.name ?? t('messages.someone');
  const actors = actorsText(g.actors, nameOf, t);
  const key = (KNOWN.has(g.type) ? `activity.type.${g.type}` : 'activity.type.other') as MessageKey;
  const text = t(key, { actors });
  const sealed = preview(g.head as NotificationRow);
  const inner: ReactNode = (
    <>
      <span className="k-act-lead">
        <PersonAvatar id={g.actors[0]} size={48} />
        <span className="k-act-kind" aria-hidden><Icon name={activityIcon(g.type) as IconName} /></span>
      </span>
      <span className="k-act-body">
        <span className="k-act-text">{text}</span>
        {sealed ? <span className="k-act-preview" dir="auto">“{sealed}”</span> : null}
        <time className="k-act-time" dateTime={g.latest}>{f.date(new Date(g.latest), { timeStyle: 'short' })}</time>
      </span>
      {g.unread ? <span className="k-act-dot" role="img" aria-label={t('messages.unread')} /> : null}
    </>
  );
  return (
    <li>
      {href
        ? <Link href={href} className={cx('k-act-item', g.unread && 'is-unread')} onClick={() => onOpen(g)}>{inner}</Link>
        : <div className={cx('k-act-item', g.unread && 'is-unread')}>{inner}</div>}
    </li>
  );
}

function AllTab() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  useKeyringVersion();
  const notifs = useNotifications(100);
  const circles = useCircleOfPosts(notifs.data);
  const dayLabel = useDay();
  const days = useMemo(() => groupActivity(notifs.data ?? []), [notifs.data]);
  const unread = (notifs.data ?? []).some((n) => !n.read_at);
  const [busy, setBusy] = useState(false);

  async function open(g: ActivityGroup) {
    if (!g.unread) return;
    try { await Promise.all(g.ids.map((id) => markRead(id))); await qc.invalidateQueries({ queryKey: ['notifications'] }); } catch { /* best effort */ }
  }
  async function readAll() {
    setBusy(true);
    try { await markAllRead(); await qc.invalidateQueries({ queryKey: ['notifications'] }); }
    catch { toast({ message: t('activity.failed'), tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (notifs.isLoading) {
    return (
      <Card><div className="k-stack-sm" aria-busy>
        {[0, 1, 2].map((i) => <div key={i} className="k-row"><Skeleton circle width={48} height={48} /><div className="k-stack-sm" style={{ flex: 1 }}><Skeleton text width="70%" /><Skeleton text width="30%" /></div></div>)}
      </div></Card>
    );
  }
  if (notifs.isError) return <Callout tone="danger">{t('activity.loadFailed')}</Callout>;
  if (!days.length) return <Card><EmptyState icon="activity" title={t('activity.caughtUp')} body={t('activity.caughtUpBody')} /></Card>;
  return (
    <div className="k-stack">
      {unread ? <div className="k-act-toolbar"><Button size="sm" variant="ghost" icon="check" busy={busy} onClick={() => void readAll()}>{t('activity.markAllRead')}</Button></div> : null}
      {days.map((d) => (
        <section key={d.day} className="k-act-day" aria-label={dayLabel(d.at)}>
          <h2 className="k-section-title">{dayLabel(d.at)}</h2>
          <Card padding="tight">
            <ul className="k-act-list">
              {d.groups.map((g) => <Item key={g.key} g={g} href={activityHref(g, circles.data, people.get(g.actors[0] ?? '')?.username)} onOpen={(x) => void open(x)} />)}
            </ul>
          </Card>
        </section>
      ))}
      <p className="k-center k-small k-muted">{t('activity.endNote')}</p>
    </div>
  );
}

function requestNote(r: FriendshipRow, me: string): string | null {
  if (!r.note) return null;
  const from = people.get(r.requested_by);
  if (!from) return null;
  try {
    const id = identity();
    const bytes = openSealed({ sealed: r.note as Sealed, recipientKxPriv: id.kxPriv, recipientKxPub: id.kxPub, senderSignPub: b64u.decode(from.sign_pub), context: `friend-note/${r.requested_by}/${me}` });
    return new TextDecoder().decode(bytes);
  } catch { return null; }
}

function RequestsTab() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { userId } = useSession();
  usePeopleVersion();
  const reqs = useRequests();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, accept: boolean) {
    setBusy(id);
    try {
      if (accept) await acceptFriend(id); else await ignoreRequest(id);
      await Promise.all([qc.invalidateQueries({ queryKey: ['requests'] }), qc.invalidateQueries({ queryKey: ['friends'] })]);
      const name = people.person(id)?.name ?? '';
      toast({ message: accept ? t('activity.accepted', { name }) : t('activity.declined') });
    } catch { toast({ message: t('activity.failed'), tone: 'danger' }); }
    finally { setBusy(null); }
  }

  if (reqs.isLoading) return <Card><Skeleton height={64} /></Card>;
  if (reqs.isError) return <Callout tone="danger">{t('activity.loadFailed')}</Callout>;
  const list = reqs.data ?? [];
  if (!list.length) return <Card><EmptyState icon="users" title={t('activity.noRequests')} body={t('activity.noRequestsBody')} /></Card>;
  return (
    <Card padding="tight">
      <ul className="k-act-list">
        {list.map((r) => {
          const p = people.person(r.requested_by);
          const note = userId ? requestNote(r, userId) : null;
          return (
            <li key={r.requested_by} className="k-act-req">
              <PersonAvatar id={r.requested_by} size={48} />
              <span className="k-act-req-body">
                <span className="k-act-text"><b>{p?.name ?? t('messages.someone')}</b></span>
                {p?.username ? <span className="k-small k-muted k-ltr">@{p.username}</span> : null}
                {note ? <span className="k-act-preview" dir="auto">“{note}”</span> : null}
              </span>
              <span className="k-act-req-actions">
                <Button size="sm" variant="primary" busy={busy === r.requested_by} disabled={!!busy} onClick={() => void act(r.requested_by, true)}>{t('activity.accept')}</Button>
                <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void act(r.requested_by, false)}>{t('activity.decline')}</Button>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function ActivityScreen({ initialTab }: { initialTab?: string }) {
  const t = useT();
  const reqs = useRequests();
  const [tab, setTab] = useState<'all' | 'requests'>(initialTab === 'requests' ? 'requests' : 'all');
  useDocumentTitle(t('nav.activity'));
  return (
    <Page title={t('nav.activity')} description={t('activity.description')}>
      <Tabs
        label={t('nav.activity')}
        value={tab}
        onChange={setTab}
        items={[
          { value: 'all', label: t('activity.all'), panel: <AllTab /> },
          { value: 'requests', label: t('activity.requests'), count: reqs.data?.length ?? 0, panel: <RequestsTab /> },
        ]}
      />
    </Page>
  );
}
