'use client';
// Members tab: who's in the circle, invitations, roles (admin/member), remove (rotates the circle's
// key so they can't read anything new), and leave.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { me } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { List, ListItem } from '@/components/ui/ListItem';
import { useToast } from '@/components/ui/Toast';
import {
  inviteToCircle, isAdmin, leaveCircle, readCircle, removeFromCircle, setRole, useCircleMembers,
  type CircleSummary, type MemberRow,
} from './data';
import { ConnectionPicker, E2eeLine, Loading, PersonAvatar, SectionHead } from './shared';

type Pending = { kind: 'remove' | 'promote' | 'demote'; m: MemberRow } | { kind: 'leave' } | null;

function MemberRowView({ m, s, canManage, onAct }: { m: MemberRow; s: CircleSummary; canManage: boolean; onAct: (p: Pending) => void }) {
  const t = useT();
  const p = usePerson(m.member_id);
  const creator = m.member_id === s.circle.creator_id;
  const self = m.member_id === me();
  const role = creator ? t('circles.role.creator') : m.role === 'admin' ? t('circles.role.admin') : null;
  const sub = m.status === 'invited' ? t('circles.members.invited') : p?.username ? `@${p.username}` : undefined;
  return (
    <li>
      <ListItem
        leading={<PersonAvatar id={m.member_id} size={40} />}
        title={<>{p?.name ?? '…'}{self ? <span className="k-muted"> · {t('circles.members.you')}</span> : null}</>}
        subtitle={sub}
        trailing={
          <span className="k-row-wrap kc-member-actions">
            {role ? <Badge tone="soft" className="k-badge-label">{role}</Badge> : null}
            {canManage && !creator && !self ? (
              <>
                {m.status === 'active' ? (
                  <Button size="sm" variant="ghost" onClick={() => onAct({ kind: m.role === 'admin' ? 'demote' : 'promote', m })}>
                    {m.role === 'admin' ? t('circles.members.demote') : t('circles.members.promote')}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => onAct({ kind: 'remove', m })}>
                  {m.status === 'invited' ? t('circles.members.cancelInvite') : t('circles.members.remove')}
                </Button>
              </>
            ) : null}
          </span>
        }
      />
    </li>
  );
}

export function CircleMembers({ s, onInvite }: { s: CircleSummary; onInvite: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useCircleMembers(s.circle);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const admin = isAdmin(s.circle, s.membership);
  const d = readCircle(s.circle);
  const name = d.ok ? d.value.name : t('circles.ui.sealedCircle');
  const rows = q.data ?? [];
  const active = rows.filter((m) => m.status === 'active');
  const invited = rows.filter((m) => m.status === 'invited');
  const creator = s.circle.creator_id === me();

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === 'leave') {
        await leaveCircle(s.circle);
        void qc.invalidateQueries({ queryKey: ['circles'] });
        toast({ message: t('circles.members.left', { name }) });
        router.replace('/circles');
        return;
      }
      if (pending.kind === 'remove') await removeFromCircle(s.circle, pending.m.member_id);
      else await setRole(s.circle.audience_id, pending.m.member_id, pending.kind === 'promote' ? 'admin' : 'member');
      void qc.invalidateQueries({ queryKey: ['circles'] });
      setPending(null);
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
    } finally { setBusy(false); }
  };

  const who = usePerson(pending && pending.kind !== 'leave' ? pending.m.member_id : null)?.name ?? '';
  const dialogText = !pending ? '' : pending.kind === 'leave' ? t('circles.members.leaveBody')
    : pending.kind === 'remove' ? t('circles.members.removeBody', { name: who })
      : pending.kind === 'promote' ? t('circles.members.promoteBody', { name: who }) : t('circles.members.demoteBody', { name: who });
  const dialogTitle = !pending ? '' : pending.kind === 'leave' ? t('circles.members.leaveTitle', { name })
    : pending.kind === 'remove' ? t('circles.members.removeTitle', { name: who })
      : pending.kind === 'promote' ? t('circles.members.promote') : t('circles.members.demote');

  if (q.isLoading) return <Loading />;
  return (
    <div className="k-stack">
      <div className="k-row-wrap">
        <Button variant="soft" icon="users" onClick={onInvite}>{t('circles.members.invite')}</Button>
      </div>
      <section className="k-stack-sm" aria-labelledby="kc-mem-h">
        <SectionHead id="kc-mem-h" title={t('circles.home.members', { count: active.length })} />
        <Card padding="flush"><List label={t('circles.tab.members')}>
          {active.map((m) => <MemberRowView key={m.member_id} m={m} s={s} canManage={admin} onAct={setPending} />)}
        </List></Card>
      </section>
      {invited.length ? (
        <section className="k-stack-sm" aria-labelledby="kc-invd-h">
          <SectionHead id="kc-invd-h" title={t('circles.members.invitedTitle', { count: invited.length })} />
          <Card padding="flush"><List>
            {invited.map((m) => <MemberRowView key={m.member_id} m={m} s={s} canManage={admin} onAct={setPending} />)}
          </List></Card>
        </section>
      ) : null}
      <E2eeLine>{t('circles.members.rotationNote')}</E2eeLine>
      {!creator ? (
        <div><Button variant="secondary" icon="logout" onClick={() => setPending({ kind: 'leave' })}>{t('circles.members.leave')}</Button></div>
      ) : null}

      <Dialog open={!!pending} onClose={() => { if (!busy) setPending(null); }} title={dialogTitle} dismissible={!busy}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setPending(null)}>{t('circles.ui.cancel')}</Button>
          <Button variant={pending?.kind === 'remove' || pending?.kind === 'leave' ? 'danger' : 'primary'} busy={busy} onClick={() => void confirm()}>
            {pending?.kind === 'leave' ? t('circles.members.leave') : pending?.kind === 'remove' ? t('circles.members.remove') : t('circles.ui.confirm')}
          </Button>
        </>}>
        <p>{dialogText}</p>
      </Dialog>
    </div>
  );
}

export function InviteDialog({ s, open, onClose, members }: { s: CircleSummary; open: boolean; onClose: () => void; members: MemberRow[] }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const d = readCircle(s.circle);
  const name = d.ok ? d.value.name : '';
  const send = async () => {
    setBusy(true);
    try {
      const n = await inviteToCircle(s.circle, ids, name);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      toast({ message: t('circles.members.invitedToast', { count: n }) });
      setIds([]);
      onClose();
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('circles.members.inviteTitle', { name: name || t('circles.ui.sealedCircle') })} sheet dismissible={!busy}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('circles.ui.cancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!ids.length} onClick={() => void send()}>{t('circles.members.sendInvites', { count: ids.length })}</Button>
      </>}>
      <div className="k-stack">
        <p className="k-muted k-small">{isAdmin(s.circle, s.membership) ? t('circles.members.inviteBodyAdmin') : t('circles.members.inviteBodyMember')}</p>
        <ConnectionPicker value={ids} onChange={setIds} exclude={members.map((m) => m.member_id)} />
      </div>
    </Dialog>
  );
}
