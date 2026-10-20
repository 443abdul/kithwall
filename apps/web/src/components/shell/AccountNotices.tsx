'use client';
// Security notices at the top of every signed-in screen (spec §3.5 step 2: every signed-in session
// hears about recovery requests). Trusted-friend recovery can be started by anyone who knows a handle
// (docs/v2/01-accounts.md §5), so the owner's devices must show it with a one-tap cancel. Also:
// a cancelled "I've lost everything" deletion, friends asking me for help, and moderation decisions.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { sb } from '@/lib/supabase';
import { useSession } from '@/lib/keys/session';
import { loadSettings } from '@/lib/settings';
import { cancelRequest, incomingRecoveryRequests, type RequestRow } from '@/lib/recovery';
import { people, usePeopleVersion } from '@/lib/people';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';

interface ModAction { id: string; action: string; reason: string; created_at: string; expires_at: string | null }
const DISMISS = 'kw.dismissedNotices';
const MOD_TITLES = ['warn', 'remove_content', 'suspend', 'ban', 'restore'] as const;

function dismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(DISMISS) ?? '[]') as string[]; } catch { return []; }
}

export function AccountNotices() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const { status, userId } = useSession();
  const [cancelledDeletion, setCancelledDeletion] = useState(false);
  const [ownRecovery, setOwnRecovery] = useState<RequestRow[]>([]);
  const [helpNeeded, setHelpNeeded] = useState<string[]>([]);
  const [actions, setActions] = useState<ModAction[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  usePeopleVersion();

  useEffect(() => {
    const on = () => { setCancelledDeletion(true); try { sessionStorage.removeItem('kw.deletionCancelled'); } catch { /* ignore */ } };
    window.addEventListener('kw:deletion-cancelled', on);
    return () => window.removeEventListener('kw:deletion-cancelled', on);
  }, []);

  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    let live = true;
    setHidden(dismissed());
    void loadSettings().catch(() => undefined);
    void (async () => {
      try {
        if (sessionStorage.getItem('kw.deletionCancelled')) { setCancelledDeletion(true); sessionStorage.removeItem('kw.deletionCancelled'); }
        const { data: del } = await sb().from('account_deletion_requests').select('user_id').maybeSingle();
        if (del) { const { data } = await sb().rpc('cancel_account_deletion'); if (data === true && live) setCancelledDeletion(true); }
        const { data: reqs } = await sb().from('recovery_requests').select('*').eq('owner_id', userId).eq('status', 'pending')
          .gt('expires_at', new Date().toISOString());
        if (live) setOwnRecovery((reqs ?? []) as RequestRow[]);
        const incoming = await incomingRecoveryRequests().catch(() => []);
        if (live) setHelpNeeded(incoming.filter((r) => !r.responded).map((r) => r.owner_id));
        const since = new Date(Date.now() - 30 * 86400_000).toISOString();
        const { data: acts } = await sb().from('moderation_actions').select('id, action, reason, created_at, expires_at')
          .eq('target_user_id', userId).gt('created_at', since).order('created_at', { ascending: false }).limit(5);
        if (live) setActions((acts ?? []) as ModAction[]);
      } catch (e) { console.warn('account notices', e); }
    })();
    return () => { live = false; };
  }, [status, userId]);

  if (status !== 'ready') return null;
  const hide = (id: string) => {
    const next = [...hidden, id];
    setHidden(next);
    try { localStorage.setItem(DISMISS, JSON.stringify(next.slice(-50))); } catch { /* ignore */ }
  };
  const shownActions = actions.filter((a) => !hidden.includes(a.id));
  if (!cancelledDeletion && !ownRecovery.length && !helpNeeded.length && !shownActions.length) return null;
  const time = (iso: string) => f.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="k-notices" role="region" aria-label={t('notices.label')}>
      {ownRecovery.map((r) => (
        <div className="k-notice k-notice-danger" role="alert" key={r.id}>
          <Icon name="alert" />
          <div className="k-notice-body">
            <strong>{t('notices.recoveryTitle')}</strong>
            <p>{t('notices.recoveryBody', { started: time(r.created_at), time: time(r.not_before) })}</p>
            <div className="k-row-wrap">
              <Button size="sm" variant="danger" onClick={() => void cancelRequest(r.id).then(() => {
                setOwnRecovery((x) => x.filter((y) => y.id !== r.id));
                toast({ message: t('notices.recoveryCancelled') });
              }).catch(() => toast({ message: t('errors.unknown'), tone: 'danger' }))}>{t('notices.recoveryCancel')}</Button>
              <span className="k-small k-muted">{t('notices.recoveryMine')}</span>
            </div>
          </div>
        </div>
      ))}
      {helpNeeded.length > 0 ? (
        <div className="k-notice">
          <Icon name="key" />
          <div className="k-notice-body">
            <strong>{t('notices.helpTitle', { names: helpNeeded.map((id) => people.person(id)?.name ?? '…').join(', '), count: helpNeeded.length })}</strong>
            <p>{t('notices.helpBody')} <Link href="/you/settings/security#trusted">{t('notices.helpCta')}</Link></p>
          </div>
        </div>
      ) : null}
      {cancelledDeletion ? (
        <div className="k-notice">
          <Icon name="shield" />
          <div className="k-notice-body">
            <strong>{t('notices.deletionTitle')}</strong>
            <p>{t('notices.deletionBody')} <Link href="/you/settings/security">{t('settings.security.title')}</Link></p>
          </div>
          <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={() => setCancelledDeletion(false)} />
        </div>
      ) : null}
      {shownActions.map((a) => (
        <div className="k-notice k-notice-danger" key={a.id}>
          <Icon name="flag" />
          <div className="k-notice-body">
            <strong>{t((MOD_TITLES as readonly string[]).includes(a.action) ? `notices.mod.${a.action as typeof MOD_TITLES[number]}` : 'notices.mod.other')}</strong>
            <p dir="auto">{a.reason}</p>
            {a.expires_at && a.action === 'suspend' ? <p className="k-small">{t('notices.modUntil', { time: time(a.expires_at) })}</p> : null}
            <p className="k-small"><Link href="/legal/community">{t('footer.community')}</Link></p>
          </div>
          <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={() => hide(a.id)} />
        </div>
      ))}
    </div>
  );
}
