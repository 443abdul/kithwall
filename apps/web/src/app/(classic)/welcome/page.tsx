'use client';
// First login: create encryption keys + username, show the 24-word recovery key, save the
// encrypted profile. (2010's "Getting Started" steps, with a key step added.)
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { completeSetup, initSession, me, useSession } from '@/lib/keys/session';
import { notify, saveProfileInfo } from '@/lib/friends';
import { sb } from '@/lib/supabase';
import { mfaRequired } from '@/lib/auth/login';
import { MfaForm } from '@/components/auth/MfaForm';
import { pendingInvite, rememberInvite } from '@/components/auth/Splash';
import { Footer, Header, Loading } from '@/components/Shell';
import type { ProfileInfo } from '@/lib/types';

type Step = 'keys' | 'phrase' | 'confirm' | 'done';

export default function Welcome() {
  const { status } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<Step>('keys');
  const [phrase, setPhrase] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const pending = useMemo<Partial<ProfileInfo>>(() => {
    try { return JSON.parse(sessionStorage.getItem('kw.pendingProfile') ?? '{}'); } catch { return {}; }
  }, []);
  const checks = useMemo(() => {
    const idx = new Set<number>(); while (idx.size < 3) idx.add(Math.floor(Math.random() * 24)); return [...idx].sort((a, b) => a - b);
  }, []);

  // Invite links look like /welcome?invite=CODE. Keep the code until sign-up and setup are done.
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('invite');
    if (code) rememberInvite(code);
  }, []);

  useEffect(() => {
    if (status === 'signed_out') { const inv = pendingInvite(); router.replace(inv ? `/?invite=${inv}` : '/'); }
    if (status === 'ready' && step === 'keys' && !started) router.replace('/');
    // An account with two-step verification can't see its keys until the code is entered.
    if (status === 'setup' && !started) void mfaRequired().then(setMfa);
  }, [status, step, started, router]);

  if (status === 'loading' || status === 'signed_out') return <Loading />;

  if (mfa) {
    return (
      <>
        <div id="blue"><div id="hd"><span id="logo">kithwall</span></div></div>
        <main id="body" style={{ maxWidth: 620, padding: '20px 12px 40px' }}>
          <div className="ttl"><h2>Two-Step Verification</h2></div>
          <MfaForm onVerified={async () => { await initSession(); setMfa(false); router.replace('/'); }} />
        </main>
        <Footer />
      </>
    );
  }

  /** After setup: an invite sends a friend request to the person who invited me. */
  async function redeemInvite() {
    const code = pendingInvite();
    if (!code) return;
    try {
      const { data: inviter, error } = await sb().rpc('redeem_invite', { invite_code: code });
      if (error) throw new Error(error.message);
      if (typeof inviter === 'string') await notify(inviter, 'friend_request', 'profile', me()).catch(() => undefined);
      setInviteNote('We sent a friend request to the person who invited you.');
    } catch {
      setInviteNote('That invite link has expired or was used up, so no friend request was sent.');
    } finally { rememberInvite(null); }
  }

  async function onKeys(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const username = String(f.get('username')).trim().toLowerCase();
    const name = String(f.get('name')).trim();
    if (!/^[a-z0-9][a-z0-9.]{2,29}$/.test(username)) return setErr('Usernames are 3–30 characters: letters, numbers and periods.');
    if (!name) return setErr('Please enter your name.');
    setBusy(true); setErr(null); setStarted(true);
    try {
      const words = await completeSetup({
        password: String(f.get('pw')), username, directoryName: f.get('directory') === 'on' ? name : null,
      });
      await saveProfileInfo({ ...pending, name } as ProfileInfo);
      sessionStorage.removeItem('kw.pendingProfile');
      await redeemInvite();
      setPhrase(words.split(' '));
      setStep('phrase');
    } catch (x) { setErr((x as Error).message); setStarted(false); } finally { setBusy(false); }
  }

  function onConfirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = checks.every((i) => String(f.get(`w${i}`)).trim().toLowerCase() === phrase[i]);
    if (!ok) return setErr('Those words don\'t match your recovery key. Check what you wrote down.');
    setErr(null); setStep('done');
  }

  return (
    <>
      {status === 'ready' ? <Header /> : <div id="blue"><div id="hd"><span id="logo">kithwall</span></div></div>}
      <main id="body" style={{ maxWidth: 620, padding: '20px 12px 40px' }}>
        <div className="ttl"><h2>Getting Started</h2><div className="r">Step {({ keys: 1, phrase: 2, confirm: 3, done: 4 })[step]} of 4</div></div>
        {err && <div className="err" role="alert">{err}</div>}

        {step === 'keys' && (
          <form className="form" onSubmit={onKeys}>
            <p style={{ marginBottom: 10, lineHeight: '16px' }}>Welcome to Kithwall! First we&rsquo;ll create your <b>encryption keys</b> on this device.
              They lock everything you share so only the friends you choose can read it.</p>
            <table><tbody>
              <tr><td className="l"><label htmlFor="name">Your name:</label></td><td><input id="name" name="name" type="text" defaultValue={pending.name ?? ''} />
                <div className="gray small">Only your friends can see this.</div></td></tr>
              <tr><td className="l"><label htmlFor="username">Username:</label></td><td><input id="username" name="username" type="text" autoCapitalize="none" />
                <div className="gray small">kithwall.com/<b>username</b> &mdash; visible to signed-in users.</div></td></tr>
              <tr><td className="l"><label htmlFor="pw">Password:</label></td><td><input id="pw" name="pw" type="password" autoComplete="current-password" required />
                <div className="gray small">Re-enter your password to create your keys.</div></td></tr>
              <tr><td className="l" /><td><label><input type="checkbox" name="directory" /> Let people find me by name in search</label>
                <div className="gray small">Off by default. If off, people find you by username or invite link only.</div></td></tr>
              <tr><td /><td><button className="btn b big" disabled={busy}>{busy ? 'Creating keys…' : 'Create My Keys'}</button></td></tr>
            </tbody></table>
          </form>
        )}

        {step === 'phrase' && (
          <div>
            <div className="note" style={{ lineHeight: '16px' }}>
              <b>This is your recovery key.</b> Write these 24 words down on paper and keep them somewhere safe.
              If you ever forget your password, they are the only way (besides trusted friends) to get your posts back.
              Kithwall cannot recover them for you.
            </div>
            <ol style={{ columns: 3, fontSize: 13, lineHeight: '22px', fontFamily: 'monospace', background: '#fff', border: '1px solid #ccc', padding: '10px 10px 10px 36px' }}>
              {phrase.map((w, i) => <li key={i}>{w}</li>)}
            </ol>
            <p style={{ margin: '10px 0' }}><button className="btn b big" onClick={() => setStep('confirm')}>I&rsquo;ve Written It Down</button></p>
          </div>
        )}

        {step === 'confirm' && (
          <form className="form" onSubmit={onConfirm}>
            <p style={{ marginBottom: 8 }}>Let&rsquo;s make sure you wrote it down correctly.</p>
            <table><tbody>
              {checks.map((i) => (
                <tr key={i}><td className="l"><label htmlFor={`w${i}`}>Word #{i + 1}:</label></td><td><input id={`w${i}`} name={`w${i}`} type="text" autoComplete="off" autoCapitalize="none" /></td></tr>
              ))}
              <tr><td /><td><button className="btn b">Confirm</button> <a role="button" onClick={() => setStep('phrase')}>Show the words again</a></td></tr>
            </tbody></table>
          </form>
        )}

        {step === 'done' && (
          <div>
            <div className="ok"><b>You&rsquo;re all set.</b>Your keys are ready and your recovery key is saved.</div>
            {inviteNote && <div className="note">{inviteNote}</div>}
            <p style={{ lineHeight: '16px', marginBottom: 10 }}>Next: add a profile picture, find your friends, and choose <b>trusted friends</b> who can help you get back in if you lose your password and recovery key.</p>
            <p><button className="btn b big" onClick={() => router.replace('/')}>Go to My News Feed</button>{' '}
              <button className="btn big" onClick={() => router.push('/invite')}>Find Friends</button>{' '}
              <button className="btn big" onClick={() => router.push('/settings/security#trusted-setup')}>Choose Trusted Friends</button></p>
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}
