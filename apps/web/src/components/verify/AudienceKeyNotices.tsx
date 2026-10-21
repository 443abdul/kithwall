'use client';
// Key warnings for a circle or group chat (security review K1, re-review R-K-1 / R-K-2):
//  * identity: a key or key record for this audience was signed with an identity key this device doesn't
//    trust (the person's safety number changed and their old key didn't sign the change). It was NOT used.
//  * conflict: someone handed this device a key that contradicts the owner's signed record. Not used.
//  * new key authority: someone became the owner or an admin since this device last looked (lib/keys/roster.ts).
//    Admins can share the group's keys, so this is shown prominently until acknowledged.
// Plus, for circles and events, the server's content-free roster notices (who joined / became an admin).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormat, useT } from '@/i18n';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useKeyConflicts } from '@/lib/keys/keyring';
import { useAuthorityWatch } from '@/lib/keys/roster';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { sb } from '@/lib/supabase';

export function AudienceKeyNotices({ audienceId, authorities, where }: {
  audienceId: string;
  /** Current key authorities (owner + verified admins), or null when not applicable (1:1 chats) / loading. */
  authorities: string[] | null;
  where: 'chat' | 'circle';
}) {
  const t = useT();
  const f = useFormat();
  usePeopleVersion();
  const all = useKeyConflicts(audienceId);
  const conflicts = all.filter((c) => c.reason === 'conflict');
  const untrusted = [...new Set(all.filter((c) => c.reason === 'identity').map((c) => c.sealedBy))];
  const watch = useAuthorityWatch(authorities ? audienceId : null, authorities);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => people.person(id)?.name ?? '…';

  return (
    <>
      {untrusted.map((id) => {
        const name = nameOf(id);
        const handle = people.get(id)?.username;
        return (
          <div key={id} className="k-keychange" role="alert" data-testid="key-identity-warning">
            <Icon name="alert" />
            <div className="k-stack-sm">
              <p className="k-keychange-title">{t('keys.identityTitle', { name })}</p>
              <p className="k-small">{t('keys.identityBody', { name })}</p>
              {handle ? (
                <div className="k-row-wrap">
                  <ButtonLink href={`/u/${encodeURIComponent(handle)}`} size="sm" variant="primary" icon="shield">{t('keys.identityOpen', { name })}</ButtonLink>
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      {conflicts.length ? (
        <div className="k-keychange" role="alert" data-testid="key-conflict">
          <Icon name="alert" />
          <div className="k-stack-sm">
            <p className="k-keychange-title">{t(where === 'chat' ? 'keys.conflictTitle' : 'keys.conflictTitleCircle')}</p>
            <p className="k-small">{t(where === 'chat' ? 'keys.conflictBody' : 'keys.conflictBodyCircle')}</p>
          </div>
        </div>
      ) : null}
      {watch.fresh.length ? (
        <div className="k-keychange" role="alert" data-testid="new-key-authority">
          <Icon name="shield" />
          <div className="k-stack-sm">
            <p className="k-keychange-title">{t('security.roster.newTitle', { people: f.list(watch.fresh.map(nameOf)) })}</p>
            <p className="k-small">{t('security.roster.newBody')}</p>
            <div className="k-row-wrap">
              <Button size="sm" variant="primary" busy={busy}
                onClick={() => { setBusy(true); void watch.acknowledge().catch(() => undefined).finally(() => setBusy(false)); }}>
                {t('security.roster.ok')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface RosterNotice { id: number; member_id: string; actor_id: string | null; kind: 'joined' | 'admin' | 'owner'; created_at: string }

/** Recent server notices about who joined or became an admin of a circle or event (R-K-2). */
export function RosterNotices({ audienceId, days, max = 10 }: { audienceId: string; days: number; max?: number }) {
  const t = useT();
  const f = useFormat();
  const { status } = useSession();
  usePeopleVersion();
  const q = useQuery({
    queryKey: ['roster-notices', audienceId, days],
    enabled: status === 'ready',
    staleTime: 30_000,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const { data } = await sb().from('audience_roster_notices').select('id, member_id, actor_id, kind, created_at')
        .eq('audience_id', audienceId).gte('created_at', since).order('created_at', { ascending: false }).limit(max);
      const rows = (data ?? []) as RosterNotice[];
      await people.ensure(rows.flatMap((r) => [r.member_id, r.actor_id ?? '']).filter(Boolean));
      return rows;
    },
  });
  const rows = q.data ?? [];
  if (!rows.length) return null;
  const nameOf = (id: string | null) => (id ? people.person(id)?.name ?? '…' : '');
  return (
    <section className="k-stack-sm" aria-label={t('security.roster.title')} data-testid="roster-notices">
      <p className="k-small k-muted">{t('security.roster.title')}</p>
      <ul className="k-roster-notices">
        {rows.map((r) => {
          const person = nameOf(r.member_id);
          const name = nameOf(r.actor_id);
          const text = r.kind === 'owner' ? t('security.roster.owner', { person })
            : r.kind === 'admin' ? (name ? t('security.roster.admin', { name, person }) : t('security.roster.adminNoActor', { person }))
              : !r.actor_id || r.actor_id === r.member_id ? t('security.roster.joined', { person }) : t('security.roster.added', { name, person });
          return (
            <li key={r.id} className={r.kind === 'joined' ? undefined : 'is-security'}>
              {r.kind === 'joined' ? null : <Icon name="shield" />}
              <span>{text}</span>
              <time dateTime={r.created_at}>{f.date(new Date(r.created_at))}</time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
