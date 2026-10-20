'use client';
// Forgot password, step 2 (spec §3.4–3.5). The email link opened a session that can read only the
// WRAPPED key bundle; to get back in you need (a) the 24-word recovery key, (b) your trusted friends,
// or (c) to give up the encrypted content and delete the account (72-hour delayed deletion).
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { PublicPage } from '@/components/auth/PublicPage';
import { MfaForm } from '@/components/auth/MfaForm';
import { NewPasswordRows, readNewPassword } from '@/components/auth/NewPassword';
import { PhraseDisplay } from '@/components/auth/PhraseDisplay';
import { initSession, recoverWithPhrase, signOut, useSession } from '@/lib/keys/session';
import { mfaRequired } from '@/lib/auth/login';
import { authedPost } from '@/lib/auth/api';
import { sb } from '@/lib/supabase';
import {
  cancelRequest, completeFriendRecovery, fetchResponses, myOpenRequest, myRecoverySetup, phraseFor, startFriendRecovery,
  type RequestRow, type ResponseRow,
} from '@/lib/recovery';
import { people, usePeopleVersion } from '@/lib/people';

type Mode = 'choose' | 'phrase' | 'friends' | 'lost';

export default function ResetPage() {
  const { status, email } = useSession();
  const [mfa, setMfa] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('choose');
  const [done, setDone] = useState<null | { newPhrase?: string }>(null);

  useEffect(() => {
    if (status === 'setup' || status === 'locked') void mfaRequired().then(setMfa); else setMfa(false);
    const h = location.hash.slice(1);
    if (h === 'friends' || h === 'phrase' || h === 'lost') setMode(h);
  }, [status]);

  let body: ReactNode;
  if (status === 'loading' || mfa === null) body = <p className="gray">Loading&hellip;</p>;
  else if (status === 'signed_out') body = (
    <div className="err"><b>This link has expired or was opened in a different browser.</b>
      Reset links work once, for an hour, in the browser where you asked for them. <Link href="/recover">Send a new link</Link>.</div>
  );
  else if (mfa) body = <MfaForm onVerified={async () => { await initSession(); setMfa(false); }} />;
  else if (status === 'setup') body = (
    <div className="note">This account never finished setting up, so there&rsquo;s nothing encrypted to recover. <Link href="/welcome">Finish setting up</Link>.</div>
  );
  else if (done) body = done.newPhrase
    ? <><div className="ok"><b>You&rsquo;re back in.</b>Your password is changed. Your trusted friends have been given pieces of your new recovery key.</div>
      <PhraseDisplay phrase={done.newPhrase} onDone={() => { location.href = '/'; }} doneLabel="Go to My News Feed" /></>
    : <><div className="ok"><b>You&rsquo;re back in.</b>Your new password is set and your keys are unlocked on this device.</div>
      <p><Link className="btn b" href="/">Go to My News Feed</Link></p></>;
  else if (mode === 'phrase') body = <PhraseRecovery email={email ?? ''} onBack={() => setMode('choose')} onDone={() => setDone({})} />;
  else if (mode === 'friends') body = <FriendsRecovery email={email ?? ''} onBack={() => setMode('choose')} onDone={(p) => setDone({ newPhrase: p })} />;
  else if (mode === 'lost') body = <LostEverything onBack={() => setMode('choose')} />;
  else body = (
    <>
      {status === 'ready' && <div className="note">This device is already unlocked. You can change your password in <Link href="/settings/security">Security &amp; Recovery</Link>.</div>}
      <p style={{ marginBottom: 10, lineHeight: '16px' }}>Hi{email ? <> <b>{email}</b></> : null}. Kithwall can&rsquo;t read your encrypted posts, so choose how you&rsquo;ll prove they&rsquo;re yours:</p>
      <div className="kw-choice"><h4>I have my 24-word recovery key</h4><p>The fastest way. Enter the words and choose a new password.</p>
        <div className="kw-actions"><button type="button" className="btn b" onClick={() => setMode('phrase')}>Use My Recovery Key</button></div></div>
      <div className="kw-choice"><h4>Ask my trusted friends</h4><p>If you chose trusted friends, enough of them can help you back in. For your safety there&rsquo;s a waiting period (usually 24 hours) before they can respond.</p>
        <div className="kw-actions"><button type="button" className="btn" onClick={() => setMode('friends')}>Ask Trusted Friends</button></div></div>
      <div className="kw-choice"><h4>I&rsquo;ve lost everything</h4><p>No recovery key and no trusted friends? Your encrypted content can&rsquo;t be recovered, but you can delete this account and start over.</p>
        <div className="kw-actions"><button type="button" className="btn" onClick={() => setMode('lost')}>What Are My Options?</button></div></div>
      <p className="kw-help"><button type="button" className="kw-link" onClick={() => void signOut().then(() => { location.href = '/'; })}>Cancel and log out</button></p>
    </>
  );

  return (
    <PublicPage plainHeader>
      <div className="kw-center" style={{ padding: '20px 0' }}>
        <div className="kw-box" style={{ width: 600 }}>
          <h3>Get Back Into Your Account</h3>
          <div className="in">{body}</div>
        </div>
      </div>
    </PublicPage>
  );
}

function PhraseRecovery({ email, onBack, onDone }: { email: string; onBack: () => void; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      const pw = readNewPassword(f, [email]);
      const words = String(f.get('phrase') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length !== 24) throw new Error(`Your recovery key has 24 words; you entered ${words.length}.`);
      await recoverWithPhrase(words.join(' '), pw);
      onDone();
    } catch (x) {
      const m = (x as Error).message;
      setErr(/phrase|checksum|mnemonic|decrypt|bad_/i.test(m) ? 'That recovery key doesn\'t match this account. Check each word and try again.' : m);
    } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={onSubmit} aria-label="Recover with recovery key">
      {err && <div className="err" role="alert">{err}</div>}
      <table><tbody>
        <tr><td className="l"><label htmlFor="phrase">Recovery key:</label></td>
          <td><textarea id="phrase" name="phrase" rows={4} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="24 words, separated by spaces" required />
            <div className="kw-help">Typed exactly as you wrote them down. Order matters.</div></td></tr>
        <NewPasswordRows inputs={[email]} />
        <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Unlocking…' : 'Recover My Account'}</button> <button type="button" className="kw-link" onClick={onBack}>Back</button></td></tr>
      </tbody></table>
    </form>
  );
}

function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <b>now</b>;
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return <b>in {h}h {String(m).padStart(2, '0')}m {String(s).padStart(2, '0')}s</b>;
}

function FriendsRecovery({ email, onBack, onDone }: { email: string; onBack: () => void; onDone: (newPhrase: string) => void }) {
  usePeopleVersion();
  const [setup, setSetup] = useState<{ trustees: string[]; threshold: number } | null | undefined>(undefined);
  const [open, setOpen] = useState<{ req: RequestRow; onThisDevice: boolean } | null>(null);
  const [responses, setResponses] = useState<ResponseRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([myRecoverySetup(), myOpenRequest()]);
      setSetup(s); setOpen(o);
      if (o) setResponses(await fetchResponses(o.req.id));
    } catch (x) { setErr((x as Error).message); }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      if (open && !open.onThisDevice) await cancelRequest(open.req.id);
      await startFriendRecovery();
      await refresh();
    } catch (x) { setErr(/rate limit/i.test((x as Error).message) ? 'You\'ve started too many recovery requests today. Try again tomorrow.' : (x as Error).message); }
    finally { setBusy(false); }
  }

  async function finish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!open) return;
    setBusy(true); setErr(null);
    try {
      const pw = readNewPassword(new FormData(e.currentTarget), [email]);
      const r = await completeFriendRecovery(open.req, pw);
      onDone(r.phrase);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  if (setup === undefined) return <p className="gray">Loading&hellip;</p>;
  if (setup === null) return (
    <>
      <div className="err"><b>You haven&rsquo;t chosen any trusted friends.</b>Trusted friends have to be chosen <i>before</i> you lose your password, from Settings &rsaquo; Security &amp; Recovery.</div>
      <button type="button" className="btn" onClick={onBack}>Back</button>
    </>
  );
  const names = setup.trustees.map((t) => people.person(t)?.name ?? '…');
  const waiting = open ? new Date(open.req.not_before).getTime() > Date.now() : false;
  return (
    <div>
      {err && <div className="err" role="alert">{err}</div>}
      <p style={{ lineHeight: '16px', marginBottom: 8 }}>Your trusted friends are <b>{names.join(', ')}</b>. Any <b>{setup.threshold}</b> of them can help you back in.</p>
      {!open || !open.onThisDevice ? (
        <>
          {open && !open.onThisDevice && <div className="kw-warn"><b>A request is already open on another device.</b>Finish it there, or start a new one here (the other one will be cancelled).</div>}
          <ol style={{ lineHeight: '17px', paddingLeft: 18, marginBottom: 10 }}>
            <li>We&rsquo;ll notify your trusted friends, and email you and every device where you&rsquo;re logged in.</li>
            <li>After the waiting period, each friend sees <b>six words</b>. Call them or meet them, and read out the six words this page shows you. They should only approve if the words match.</li>
            <li>When {setup.threshold} friends have approved, you choose a new password here and get a new recovery key.</li>
          </ol>
          <button type="button" className="btn b" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Ask My Trusted Friends for Help'}</button>{' '}
          <button type="button" className="kw-link" onClick={onBack}>Back</button>
        </>
      ) : (
        <>
          <div className="kw-panel" style={{ marginBottom: 10 }}>
            <h4>Your six words &mdash; read these to your friends</h4>
            <div className="kw-words6" aria-label="Verification phrase">{phraseFor(open.req).join(' ')}</div>
            <div className="kw-help">Only share them by phone or in person. Never type them into a message: someone who took over your email could be reading.</div>
            <h4>Friends can respond {waiting ? <Countdown to={open.req.not_before} /> : 'now'}</h4>
            <div>{responses.length} of {setup.threshold} needed have responded{responses.length ? <>: {responses.map((r) => people.person(r.trustee_id)?.name ?? '…').join(', ')}</> : null}.
              <span className="gray"> (Checks every 15 seconds.) The request expires {new Date(open.req.expires_at).toLocaleString()}.</span></div>
          </div>
          {responses.length >= setup.threshold ? (
            <form className="form" onSubmit={finish} aria-label="Finish recovery">
              <p style={{ marginBottom: 6 }}><b>Enough friends have responded.</b> Choose a new password to finish.</p>
              <table><tbody>
                <NewPasswordRows inputs={[email]} prefix="fr" />
                <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Recovering…' : 'Recover My Account'}</button></td></tr>
              </tbody></table>
            </form>
          ) : (
            <div className="kw-actions">
              <button type="button" className="btn" onClick={() => void refresh()}>Check Now</button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); void cancelRequest(open.req.id).then(refresh).finally(() => setBusy(false)); }}>Cancel Request</button>
              <span className="gray">You can close this page and come back later in this browser.</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LostEverything({ onBack }: { onBack: () => void }) {
  const [sched, setSched] = useState<string | null | undefined>(undefined);
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    void sb().from('account_deletion_requests').select('execute_after').maybeSingle().then(({ data }) => setSched((data?.execute_after as string | undefined) ?? null));
  }, []);

  async function schedule() {
    setBusy(true); setErr(null);
    try { const r = await authedPost<{ executeAfter: string }>('/api/account/deletion-request', {}); setSched(r.executeAfter); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true); setErr(null);
    try { await authedPost('/api/account/deletion-request', {}, 'DELETE'); setSched(null); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  async function deleteNow() {
    setBusy(true); setErr(null);
    try { await authedPost('/api/account/delete', { mode: 'scheduled' }); setDeleted(true); await signOut().catch(() => undefined); location.href = '/?deleted=1'; }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  if (deleted) return <div className="ok"><b>Your account has been deleted.</b>You can <Link href="/">sign up again</Link> with the same email address.</div>;
  if (sched === undefined) return <p className="gray">Loading&hellip;</p>;
  const due = sched ? new Date(sched).getTime() <= Date.now() : false;
  return (
    <div style={{ lineHeight: '16px' }}>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="kw-danger">
        <b>Without your password, recovery key or trusted friends, your encrypted content is gone.</b>
        Everything you shared on Kithwall was locked on your device with keys only you had. We never had a copy of those keys,
        so nobody &mdash; not even Kithwall &mdash; can unlock your posts, photos or messages again.
      </div>
      {sched ? (
        <>
          <div className="kw-warn"><b>Your account is scheduled for deletion.</b>
            {due ? <>The waiting period is over. You can delete it now; otherwise it will be deleted automatically shortly.</>
              : <>It will be permanently deleted after <b>{new Date(sched).toLocaleString()}</b>. Logging in normally before then cancels it.</>}</div>
          <div className="kw-actions">
            {due && <button type="button" className="btn b" disabled={busy} onClick={() => void deleteNow()}>Delete My Account Now</button>}
            <button type="button" className="btn" disabled={busy} onClick={() => void cancel()}>Cancel Deletion</button>
            <button type="button" className="kw-link" onClick={() => void signOut().then(() => { location.href = '/'; })}>Log out</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ marginBottom: 6 }}>You can delete this account and start over with the same email address. Because there are no keys left to prove the account is yours,
            we can&rsquo;t delete it straight away. Instead:</p>
          <ul style={{ paddingLeft: 18, marginBottom: 8 }}>
            <li>We wait <b>72 hours</b>, and email this address to say what&rsquo;s happening.</li>
            <li>If the real owner logs in during that time, the deletion is cancelled automatically.</li>
            <li>After 72 hours the account and everything stored with it is permanently deleted.</li>
          </ul>
          <label className="kw-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand my encrypted posts, photos and messages can&rsquo;t be recovered.</label>
          <div className="kw-actions">
            <button type="button" className="btn b" disabled={!ack || busy} onClick={() => void schedule()}>{busy ? 'Scheduling…' : 'Delete My Account in 72 Hours'}</button>
            <button type="button" className="kw-link" onClick={onBack}>Back</button>
          </div>
        </>
      )}
    </div>
  );
}
