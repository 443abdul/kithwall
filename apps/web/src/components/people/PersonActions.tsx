'use client';
// The connection action for a person, by relation: Connect · Requested (cancel) · Accept/Decline ·
// Connected + Message, with an overflow menu for Remove connection / Block / Unblock / Report.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { Menu, type MenuItem } from '@/components/posts/Menu';
import { ReportDialog } from '@/components/posts/ReportDialog';
import { acceptFriend, block, cancelRequest, ignoreRequest, sendFriendRequest, unblock } from '@/lib/friends';
import { unfriendFully } from '@/lib/social/graph';
import { useRelation, type Relation } from './data';

export function PersonActions({ userId, name, compact }: { userId: string; name: string; compact?: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const rel = useRelation(userId);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const [reporting, setReporting] = useState(false);

  async function run(fn: () => Promise<unknown>, done: string, next?: Relation) {
    setBusy(true);
    try {
      await fn();
      if (next) qc.setQueryData(['friends', 'relation', userId], next);
      toast({ message: done });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['friends'] }), qc.invalidateQueries({ queryKey: ['requests'] }),
        qc.invalidateQueries({ queryKey: ['people-requests'] }), qc.invalidateQueries({ queryKey: ['v2feed'] }),
      ]);
    } catch {
      toast({ message: t('feed.failed'), tone: 'danger' });
    } finally { setBusy(false); setConfirm(null); }
  }

  const r = rel.data;
  if (!r || r === 'self') return null;
  const size = compact ? 'sm' as const : 'md' as const;
  const menu: MenuItem[] = [
    ...(r === 'connected' ? [{ label: t('people.remove'), icon: 'close' as const, onSelect: () => setConfirm('remove') }] : []),
    ...(r === 'blocked' ? [{ label: t('people.unblock'), icon: 'block' as const, onSelect: () => void run(() => unblock(userId), t('people.unblocked', { name }), 'none') }]
      : [{ label: t('people.block'), icon: 'block' as const, danger: true, onSelect: () => setConfirm('block') }]),
    { label: t('feed.report'), icon: 'flag' as const, onSelect: () => setReporting(true) },
  ];

  return (
    <div className="k-person-actions">
      {r === 'none' ? <Button size={size} variant="primary" icon="userPlus" busy={busy}
        onClick={() => void run(() => sendFriendRequest(userId), t('people.requestSent'), 'sent')}>{t('people.connect')}</Button> : null}
      {r === 'sent' ? <Button size={size} variant="secondary" icon="clock" busy={busy} title={t('people.cancelRequest')}
        onClick={() => void run(() => cancelRequest(userId), t('people.requestCancelled'), 'none')}>{t('people.requested')}</Button> : null}
      {r === 'received' ? (
        <>
          <Button size={size} variant="primary" icon="check" busy={busy}
            onClick={() => void run(() => acceptFriend(userId), t('people.nowConnected', { name }), 'connected')}>{t('people.accept')}</Button>
          <Button size={size} variant="ghost" disabled={busy}
            onClick={() => void run(() => ignoreRequest(userId), t('people.declined'), 'none')}>{t('people.decline')}</Button>
        </>
      ) : null}
      {r === 'connected' ? (
        <>
          <span className="k-chip k-chip-ok"><Icon name="userCheck" />{t('people.connected')}</span>
          <ButtonLink size={size} variant="soft" icon="messages" href={`/messages/new?to=${userId}`}>{t('people.message')}</ButtonLink>
        </>
      ) : null}
      {r === 'blocked' ? <span className="k-chip">{t('profile.blockedBody')}</span> : null}
      <Menu label={t('people.more', { name })} items={menu} />

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} dismissible={!busy}
        title={confirm === 'block' ? t('people.blockTitle', { name }) : t('people.removeTitle', { name })}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>{t('feed.cancel')}</Button>
          {confirm === 'block'
            ? <Button variant="danger" busy={busy} onClick={() => void run(() => block(userId), t('people.blocked', { name }), 'blocked')}>{t('people.block')}</Button>
            : <Button variant="danger" busy={busy} onClick={() => void run(() => unfriendFully(userId), t('people.removed'), 'none')}>{t('people.remove')}</Button>}
        </>}>
        <p>{confirm === 'block' ? t('people.blockBody') : t('people.removeBody')}</p>
      </Dialog>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} kind="profile" id={userId} />
    </div>
  );
}
