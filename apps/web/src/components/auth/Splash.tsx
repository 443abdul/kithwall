'use client';
// Logged-out splash (reference vSplash): login in the blue header, 2010 world art on the left,
// sign-up form on the right. Sign-up runs a self-hosted ALTCHA proof-of-work in the background
// (verified by the before-user-created auth hook) and checks password strength on the device.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { signUp } from '@/lib/keys/session';
import { logIn } from '@/lib/auth/login';
import { fetchChallenge, solve } from '@/lib/auth/altcha';
import { passwordStrength } from '@/lib/auth/password';
import { useHydrated } from '@/lib/auth/hydrated';
import { Footer } from '@/components/Shell';
import { MONTHS } from '@/lib/format';
import '@/styles/auth.css';

export const MIN_AGE = 16;
const INVITE_KEY = 'kw.invite';

export function pendingInvite(): string | null {
  try { const v = sessionStorage.getItem(INVITE_KEY); return v && /^[0-9a-f]{16,64}$/.test(v) ? v : null; } catch { return null; }
}
export function rememberInvite(code: string | null) {
  try { if (code && /^[0-9a-f]{16,64}$/.test(code)) sessionStorage.setItem(INVITE_KEY, code); else if (!code) sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}

export function LoggedOutHeader() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      const st = await logIn(String(f.get('email')), String(f.get('pw')), f.get('keep') === 'on');
      if (st === 'mfa') router.push('/login?step=code');
      else router.replace(st === 'setup' ? '/welcome' : '/');
    } catch (x) {
      setErr((x as Error).message);
      router.push(`/login?error=${encodeURIComponent((x as Error).message.slice(0, 200))}&email=${encodeURIComponent(String(f.get('email')).slice(0, 200))}`);
    } finally { setBusy(false); }
  }
  return (
    <div id="sblue">
      <div className="in">
        <Link className="lg" href="/">kithwall</Link>
        <form className="lform" onSubmit={onLogin} aria-label="Log in">
          <div><label htmlFor="lemail">Email</label><input id="lemail" type="email" name="email" autoComplete="username" required />
            <div className="k"><input type="checkbox" name="keep" id="keep" style={{ margin: 0 }} /> <label htmlFor="keep" style={{ display: 'inline', color: '#98a9ca', margin: 0 }}>Keep me logged in</label></div></div>
          <div><label htmlFor="lpw">Password</label><input id="lpw" type="password" name="pw" autoComplete="current-password" required />
            <div className="k"><Link href="/recover">Forgot your password?</Link></div></div>
          <button className="btn" disabled={busy || !hydrated}>{busy ? 'Unlocking…' : 'Log In'}</button>
        </form>
      </div>
      {err ? <span className="sr-only" role="alert">{err}</span> : null}
    </div>
  );
}

export function WorldArt() {
  const nodes: [number, number, string][] = [[88, 52, '#7a9cc9'], [140, 140, '#c98bb0'], [262, 42, '#8fb37a'], [278, 112, '#e0a96d'], [382, 48, '#b48ed1'], [452, 138, '#6fb3b0'], [196, 92, '#d98a8a'], [340, 96, '#c4b45a']];
  const links = [[0, 6], [6, 2], [2, 4], [4, 7], [7, 3], [3, 1], [6, 3], [2, 7], [7, 5], [0, 2], [6, 7]] as const;
  return (
    <svg width="537" height="195" viewBox="0 0 537 195" style={{ maxWidth: '100%', height: 'auto' }} aria-hidden>
      <defs><pattern id="dp" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.2" fill="#b5c3dd" /></pattern></defs>
      <g fill="url(#dp)">
        <path d="M40 40L120 25 170 35 160 60 130 80 115 105 95 100 70 75 45 65Z" /><path d="M120 115L150 112 165 135 145 175 130 185 125 150Z" />
        <path d="M240 35L290 28 300 50 270 62 248 58Z" /><path d="M245 75L295 70 310 100 290 150 270 155 255 115 240 95Z" />
        <path d="M300 25L420 20 470 40 455 70 420 80 400 100 360 90 320 70 305 50Z" /><path d="M430 130L475 125 485 150 450 160 428 150Z" />
      </g>
      {links.map(([a, b]) => { const [x1, y1] = nodes[a]!; const [x2, y2] = nodes[b]!; return <path key={`${a}-${b}`} d={`M${x1} ${y1}Q${(x1 + x2) / 2} ${Math.min(y1, y2) - 30} ${x2} ${y2}`} fill="none" stroke="#8ea0c4" strokeWidth="1.2" strokeDasharray="3 2" />; })}
      {nodes.map(([x, y, c]) => (
        <g key={`${x}-${y}`} transform={`translate(${x - 13} ${y - 13})`}>
          <rect width="26" height="26" fill="#fff" stroke="#9aafe5" /><rect x="2" y="2" width="22" height="22" fill={c} />
          <circle cx="13" cy="10" r="4.3" fill="rgba(255,255,255,.75)" /><path d="M5 24c0-5 3.5-8 8-8s8 3 8 8z" fill="rgba(255,255,255,.75)" />
          <rect x="17" y="15" width="7" height="8" rx="1" fill="#3b5998" /><path d="M18.5 15v-2a2 2 0 0 1 4 0v2" fill="none" stroke="#3b5998" strokeWidth="1.2" />
        </g>
      ))}
    </svg>
  );
}

function age(y: number, m: number, d: number) {
  const now = new Date(); let a = now.getFullYear() - y;
  if (now.getMonth() < m || (now.getMonth() === m && now.getDate() < d)) a--;
  return a;
}

type Pow = { state: 'idle' } | { state: 'working' } | { state: 'done'; payload: string } | { state: 'error'; message: string };

export function StrengthMeter({ pw, inputs }: { pw: string; inputs: string[] }) {
  if (!pw) return null;
  const s = passwordStrength(pw, inputs);
  const colors = ['#dd3c10', '#dd3c10', '#e2a400', '#69a74e', '#3b6e22'];
  return (
    <div aria-live="polite">
      <div className="kw-meter"><i style={{ width: `${(s.score + 1) * 20}%`, background: colors[s.score] }} /></div>
      <div className="kw-help">Password strength: <b>{s.label}</b>{s.hint ? <> &mdash; {s.hint}</> : null}</div>
    </div>
  );
}

export function Splash() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const [pw, setPw] = useState('');
  const [inputs, setInputs] = useState<string[]>([]);
  const [pow, setPow] = useState<Pow>({ state: 'idle' });
  const [closed, setClosed] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const powPromise = useRef<Promise<string> | null>(null);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= 1905; y--) years.push(y);

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    setDeleted(q.get('deleted') === '1');
    const code = q.get('invite');
    if (code) rememberInvite(code);
    setInvite(pendingInvite());
  }, []);

  // Start the proof-of-work as soon as someone starts filling in the form.
  function startPow(): Promise<string> {
    if (powPromise.current) return powPromise.current;
    setPow({ state: 'working' });
    const p = (async () => {
      const { challenge, signupsEnabled } = await fetchChallenge();
      if (!signupsEnabled) { setClosed(true); throw new Error('Kithwall isn\'t accepting new sign-ups right now.'); }
      return solve(challenge);
    })();
    p.then((payload) => setPow({ state: 'done', payload }), (e: Error) => { setPow({ state: 'error', message: e.message }); powPromise.current = null; });
    powPromise.current = p;
    return p;
  }

  async function onSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const first = String(f.get('first')).trim(), last = String(f.get('last')).trim();
    const email = String(f.get('email')).trim(), email2 = String(f.get('email2')).trim();
    const password = String(f.get('pw'));
    const bm = Number(f.get('bm')), bd = Number(f.get('bd')), by = Number(f.get('by'));
    const sex = String(f.get('sex'));
    if (!first || !last) return setErr('You must provide your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr('Please enter a valid email address.');
    if (email.toLowerCase() !== email2.toLowerCase()) return setErr('Your emails do not match. Please try again.');
    const strength = passwordStrength(password, [email, first, last]);
    if (!strength.ok) return setErr(`Please choose a stronger password. ${strength.hint ?? ''} It also protects your encrypted posts, so longer is better.`);
    if (!bm || !bd || !by) return setErr('You must indicate your full birthday to register.');
    if (age(by, bm - 1, bd) < MIN_AGE) return setErr(`You must be at least ${MIN_AGE} years old to use Kithwall.`);
    if (!sex) return setErr('Please select either Male, Female, or Prefer not to say.');
    if (!f.get('terms')) return setErr('Please confirm you have read and agree to the Terms and the Privacy Policy.');
    setBusy(true); setErr(null);
    try {
      const altcha = await startPow();
      // Name, birthday and sex never go to the server in plaintext: they're kept on this device
      // until setup, then saved inside your encrypted profile.
      sessionStorage.setItem('kw.pendingProfile', JSON.stringify({
        name: `${first} ${last}`, birthday: `${by}-${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`, sex,
      }));
      const { needsConfirmation } = await signUp({ email, password, altcha, inviteCode: invite ?? undefined });
      if (needsConfirmation) { setSent(email); return; }
      const st = await logIn(email, password, false);
      router.replace(st === 'mfa' ? '/login?step=code' : `/welcome${invite ? `?invite=${invite}` : ''}`);
    } catch (x) {
      const m = (x as Error).message;
      setErr(/already registered|already exists/i.test(m) ? 'An account with this email already exists. Try logging in, or use "Forgot your password?".' : m);
      // A failed sign-up may have spent the challenge: solve a fresh one next time.
      powPromise.current = null; setPow({ state: 'idle' });
    } finally { setBusy(false); }
  }

  return (
    <>
      <LoggedOutHeader />
      <div className="sbody">
        <div className="sin">
          <div className="sl">
            <h2>Kithwall helps you connect and share with the people in your life &mdash; and nobody else.</h2>
            <WorldArt />
            <ul style={{ color: '#333', fontSize: 13, lineHeight: '22px', paddingLeft: 18, marginTop: 14 }}>
              <li>Everything you share is <b>end-to-end encrypted</b>. Not even Kithwall can read it.</li>
              <li>No ads. No tracking. Your News Feed is just your friends.</li>
              <li>The Wall, photo albums, pokes and chat, like 2010.</li>
            </ul>
          </div>
          <div className="sr">
            {sent ? (
              <div className="ok"><b>Check your email.</b>We sent a confirmation link to {sent}. Open it on this device to finish setting up your account.</div>
            ) : (
              <>
                <h2>Sign Up</h2>
                <div className="free">It&rsquo;s free, and always will be.</div>
                {deleted && <div className="ok" style={{ marginBottom: 10 }}><b>Your account has been deleted.</b>Everything you stored on Kithwall is gone, and your keys were destroyed. Thanks for being here.</div>}
                {invite && <div className="ok" style={{ marginBottom: 10 }}><b>You&rsquo;ve been invited!</b>Sign up and we&rsquo;ll send a friend request to the person who invited you.</div>}
                {closed && <div className="kw-warn"><b>Sign-ups are paused</b>Kithwall isn&rsquo;t accepting new accounts right now. Please check back soon.</div>}
                {err && <div className="err" role="alert"><b>There was an error with your registration.</b>{err}</div>}
                <form className="sform" onSubmit={onSignUp} onFocus={() => { void startPow().catch(() => undefined); }} aria-label="Sign up" noValidate>
                  <table><tbody>
                    <tr><td className="l"><label htmlFor="first">First Name:</label></td><td><input id="first" name="first" type="text" autoComplete="given-name" maxLength={40} /></td></tr>
                    <tr><td className="l"><label htmlFor="last">Last Name:</label></td><td><input id="last" name="last" type="text" autoComplete="family-name" maxLength={40} /></td></tr>
                    <tr><td className="l"><label htmlFor="email">Your Email:</label></td><td><input id="email" name="email" type="email" autoComplete="email" maxLength={200} onBlur={(e) => setInputs((i) => [e.target.value, ...i.slice(1)])} /></td></tr>
                    <tr><td className="l"><label htmlFor="email2">Re-enter Email:</label></td><td><input id="email2" name="email2" type="email" autoComplete="email" maxLength={200} /></td></tr>
                    <tr><td className="l"><label htmlFor="pw">New Password:</label></td><td><input id="pw" name="pw" type="password" autoComplete="new-password" maxLength={256} value={pw} onChange={(e) => setPw(e.target.value)} />
                      <StrengthMeter pw={pw} inputs={inputs} /></td></tr>
                    <tr><td className="l"><label htmlFor="sex">I am:</label></td><td><select id="sex" name="sex" defaultValue=""><option value="">Select Sex:</option><option>Female</option><option>Male</option><option>Prefer not to say</option></select></td></tr>
                    <tr><td className="l">Birthday:</td><td>
                      <select name="bm" aria-label="Month" defaultValue=""><option value="">Month:</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m.slice(0, 3)}</option>)}</select>{' '}
                      <select name="bd" aria-label="Day" defaultValue=""><option value="">Day:</option>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>{' '}
                      <select name="by" aria-label="Year" defaultValue=""><option value="">Year:</option>{years.map((y) => <option key={y}>{y}</option>)}</select>
                      <div style={{ marginTop: 4 }}><button type="button" className="kw-link" aria-expanded={why} onClick={() => setWhy((v) => !v)}>Why do I need to provide my birthday?</button></div>
                      {why && <div className="note" style={{ marginTop: 6 }}>We use it to confirm you&rsquo;re old enough to use Kithwall. It stays on your device and inside your encrypted profile &mdash; Kithwall&rsquo;s servers never see it.</div>}
                    </td></tr>
                    <tr><td className="l">Security Check:</td><td>
                      <div className="kw-check" aria-live="polite">
                        <span className={`dot${pow.state === 'done' ? ' ok' : ''}`} aria-hidden>{pow.state === 'done' ? '✓' : ''}</span>
                        {pow.state === 'idle' && <span className="gray">Starts when you fill in the form.</span>}
                        {pow.state === 'working' && <span>Checking you&rsquo;re a person&hellip; <span className="gray">(this takes a few seconds)</span></span>}
                        {pow.state === 'done' && <span>Verified. No tracking, no puzzles.</span>}
                        {pow.state === 'error' && <span style={{ color: '#a42a0b' }}>{pow.message} <button type="button" className="kw-link" onClick={() => void startPow().catch(() => undefined)}>Try again</button></span>}
                      </div>
                    </td></tr>
                    <tr><td /><td><label className="kw-check" style={{ alignItems: 'flex-start', width: 260, fontSize: 11 }}>
                      <input type="checkbox" name="terms" style={{ marginTop: 2 }} />
                      <span>I have read and agree to the <Link href="/legal/terms">Terms</Link> and the <Link href="/legal/privacy">Privacy Policy</Link>, and I&rsquo;m at least {MIN_AGE}.</span>
                    </label></td></tr>
                    <tr><td /><td style={{ paddingTop: 6 }}><button className="btn gr big" disabled={busy || closed || !hydrated}>{busy ? (pow.state === 'working' ? 'Finishing security check…' : 'Creating your account…') : 'Sign Up'}</button></td></tr>
                  </tbody></table>
                </form>
                <div className="sbot">Lost your password? Kithwall can&rsquo;t read your posts, so <Link href="/help#recovery">here&rsquo;s how recovery works</Link>.</div>
              </>
            )}
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '8px 10px', color: '#999', lineHeight: '18px' }}>English (US)</div>
      <Footer />
    </>
  );
}
