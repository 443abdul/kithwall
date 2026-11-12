'use client';
// The connection action for a person, by relation: Connect · Requested (cancel) · Accept/Decline ·
// Connected + Message, with an overflow menu for Remove connection / Block / Unblock / Report.
// For accounts that let people follow them (docs/v2/10-follow-public.md): Follow / Following (instant, no
// approval; a connection already counts as a follower). The menu also removes someone from my followers
// and restricts or unrestricts them (their comments on my posts are then shown only to them and to me).
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
import { usePerson } from '@/lib/people';
import { useRelation, type Relation } from './data';
import { follow, followInfo, followKey, followKeyReady, removeFollower, restrict, restrictedKey, unfollow, unrestrict, useFollowInfo, useRestricted } from '@/lib/follow/follow';
import { useSession } from '@/lib/keys/session';
import { useIsAutomated } from '@/lib/official/client';

export function PersonActions({ userId, name, compact }: { userId: string; name: string; compact?: boolean }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const rel = useRelation(userId);
  // A remembered account (lib/legacy) takes no new connections or chats; the server refuses them too.
  const remembered = !!usePerson(userId)?.memorialised_at;
  // An automated Kithwall account (docs/v2/13-official-accounts.md) can be followed, not connected with.
  const automated = useIsAutomated(userId);
  const myFollowOn = !!useSession().profile?.follow_enabled;
  const fi = useFollowInfo(userId).data ?? null;
  const restricted = useRestricted();
  const isRestricted = !!restricted.data?.has(userId);
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
        qc.invalidateQueries({ queryKey: ['follows'] }),
      ]);
    } catch {
      toast({ message: t('feed.failed'), tone: 'danger' });
    } finally { setBusy(false); setConfirm(null); }
  }

  const r = rel.data;
  if (!r || r === 'self') return null;
  const size = compact ? 'sm' as const : 'md' as const;
  // Following: offered when the account allows it; a connection already counts as a follower.
  const canFollow = !!fi?.followEnabled && r !== 'blocked' && r !== 'connected' && !remembered;
  async function doFollow() {
    await follow(userId);
    // The key of their Followers posts arrives when one of their devices is next online: say so honestly.
    const after = await qc.fetchQuery({ queryKey: followKey(userId), staleTime: 0, queryFn: () => followInfo(userId) }).catch(() => null);
    if (after && !followKeyReady(after)) toast({ message: t('follow.waitingKey', { name }) });
  }
  const menu: MenuItem[] = [
    ...(fi?.followsMe && myFollowOn && r !== 'blocked' ? [{ label: t('follow.removeFollower'), icon: 'close' as const, onSelect: () => void run(() => removeFollower(userId), t('follow.followerRemoved', { name })) }] : []),
    ...(r !== 'blocked' ? [{
      label: isRestricted ? t('restrict.undo', { name }) : t('restrict.action', { name }), icon: 'eyeOff' as const,
      onSelect: () => void run(async () => { if (isRestricted) await unrestrict(userId); else await restrict(userId); await qc.invalidateQueries({ queryKey: restrictedKey }); },
        t(isRestricted ? 'restrict.undone' : 'restrict.done', { name })),
    }] : []),
    ...(r === 'connected' ? [{ label: t('people.remove'), icon: 'close' as const, onSelect: () => setConfirm('remove') }] : []),
    ...(r === 'blocked' ? [{ label: t('people.unblock'), icon: 'block' as const, onSelect: () => void run(() => unblock(userId), t('people.unblocked', { name }), 'none') }]
      : [{ label: t('people.block'), icon: 'block' as const, danger: true, onSelect: () => setConfirm('block') }]),
    { label: t('feed.report'), icon: 'flag' as const, onSelect: () => setReporting(true) },
  ];

  return (
    <div className="k-person-actions">
      {remembered ? <span className="k-chip"><Icon name="heart" />{t('legacy.profile.chip')}</span> : null}
      {canFollow && !fi!.iFollow ? <Button size={size} variant="primary" icon="plus" busy={busy}
        onClick={() => void run(doFollow, t('follow.followed', { name }))}>{t('follow.follow')}</Button> : null}
      {fi?.iFollow && r !== 'blocked' && r !== 'connected' ? <Button size={size} variant="secondary" icon="userCheck" busy={busy} title={t('follow.unfollow')}
        onClick={() => void run(() => unfollow(userId), t('follow.unfollowed', { name }))}>{t('follow.following')}</Button> : null}
      {r === 'none' && !remembered && !automated ? <Button size={size} variant={canFollow ? 'secondary' : 'primary'} icon="userPlus" busy={busy}
        onClick={() => void run(() => sendFriendRequest(userId), t('people.requestSent'), 'sent')}>{t('people.connect')}</Button> : null}
      {r === 'sent' ? <Button size={size} variant="secondary" icon="clock" busy={busy} title={t('people.cancelRequest')}
        onClick={() => void run(() => cancelRequest(userId), t('people.requestCancelled'), 'none')}>{t('people.requested')}</Button> : null}
      {r === 'received' && !remembered ? (
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
          {remembered ? null : <ButtonLink size={size} variant="soft" icon="messages" href={`/messages/new?to=${userId}`}>{t('people.message')}</ButtonLink>}
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
