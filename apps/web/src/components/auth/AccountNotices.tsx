'use client';
// Security notices shown at the top of every signed-in page (spec §3.5 step 2: every logged-in
// session hears about recovery requests). Also cancels an "I've lost everything" deletion as soon
// as the owner is back with their keys, and loads encrypted settings from the vault.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { useSession } from '@/lib/keys/session';
import { loadSettings } from '@/lib/settings';
import { cancelRequest, incomingRecoveryRequests, type RequestRow } from '@/lib/recovery';
import { usePeopleVersion, people } from '@/lib/people';
import { when } from '@/lib/format';
import '@/styles/auth.css';

interface Warning { id: string; action: string; reason: string; created_at: string; expires_at: string | null }
const DISMISS = 'kw.dismissedNotices';

function dismissed(): string[] { try { return JSON.parse(localStorage.getItem(DISMISS) ?? '[]') as string[]; } catch { return []; } }

export function AccountNotices() {
  const { status, userId } = useSession();
  const [cancelledDeletion, setCancelledDeletion] = useState(false);
  const [ownRecovery, setOwnRecovery] = useState<RequestRow[]>([]);
  const [helpNeeded, setHelpNeeded] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
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
    void loadSettings().catch((e) => console.warn('settings', e));
    void (async () => {
      try {
        if (sessionStorage.getItem('kw.deletionCancelled')) { setCancelledDeletion(true); sessionStorage.removeItem('kw.deletionCancelled'); }
        const { data: del } = await sb().from('account_deletion_requests').select('user_id').maybeSingle();
        if (del) { const { data } = await sb().rpc('cancel_account_deletion'); if (data === true && live) setCancelledDeletion(true); }
        const { data: reqs } = await sb().from('recovery_requests').select('*').eq('owner_id', userId).eq('status', 'pending').gt('expires_at', new Date().toISOString());
        if (live) setOwnRecovery((reqs ?? []) as RequestRow[]);
        const incoming = await incomingRecoveryRequests().catch(() => []);
        if (live) setHelpNeeded(incoming.filter((r) => !r.responded).map((r) => r.owner_id));
        const since = new Date(Date.now() - 30 * 86400_000).toISOString();
        const { data: acts } = await sb().from('moderation_actions').select('id, action, reason, created_at, expires_at').eq('target_user_id', userId).gt('created_at', since).order('created_at', { ascending: false }).limit(5);
        if (live) setWarnings((acts ?? []) as Warning[]);
      } catch (e) { console.warn('account notices', e); }
    })();
    return () => { live = false; };
  }, [status, userId]);

  if (status !== 'ready') return null;
  const hide = (id: string) => { const next = [...hidden, id]; setHidden(next); try { localStorage.setItem(DISMISS, JSON.stringify(next.slice(-50))); } catch { /* ignore */ } };
  const ACTION: Record<string, string> = { warn: 'received a warning', remove_content: 'had something removed', suspend: 'been suspended', ban: 'been banned', restore: 'had your account restored' };

  return (
    <div role="region" aria-label="Account notices">
      {cancelledDeletion && (
        <div className="kw-notice">
          <b>Welcome back.</b> Someone asked to delete your account because the password was lost. You logged in, so we&rsquo;ve <b>cancelled that deletion</b>.
          {' '}If that wasn&rsquo;t you, change your password in <Link href="/settings/security">Security &amp; Recovery</Link>. <button type="button" className="kw-link" onClick={() => setCancelledDeletion(false)}>Dismiss</button>
        </div>
      )}
      {ownRecovery.map((r) => (
        <div className="kw-notice red" key={r.id}>
          <b>Someone is trying to recover your account with your trusted friends.</b> Started {when(r.created_at)}; friends can respond after {new Date(r.not_before).toLocaleString()}.
          {' '}If this wasn&rsquo;t you, cancel it now and tell your trusted friends not to approve it.
          <div className="kw-actions">
            <button type="button" className="btn" onClick={() => void cancelRequest(r.id).then(() => setOwnRecovery((x) => x.filter((y) => y.id !== r.id)))}>Cancel This Request</button>
            <span className="gray">If it was you, finish it on the device where you started.</span>
          </div>
        </div>
      ))}
      {helpNeeded.length > 0 && (
        <div className="kw-notice">
          <b>{helpNeeded.map((id) => people.person(id)?.name ?? 'A friend').join(', ')} asked for your help getting back into {helpNeeded.length > 1 ? 'their accounts' : 'their account'}.</b>
          {' '}Call them or meet in person before you do anything. <Link href="/settings/security#trusted">Review the request</Link>
        </div>
      )}
      {warnings.filter((w) => !hidden.includes(w.id)).map((w) => (
        <div className="kw-notice red" key={w.id}>
          <b>You&rsquo;ve {ACTION[w.action] ?? 'received a moderation notice'}.</b> {w.reason}
          {w.expires_at && w.action === 'suspend' ? <> Until {new Date(w.expires_at).toLocaleString()}.</> : null}
          {' '}See the <Link href="/legal/community">Community Standards</Link>. <button type="button" className="kw-link" onClick={() => hide(w.id)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
