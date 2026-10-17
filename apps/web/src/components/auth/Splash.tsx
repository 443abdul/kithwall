'use client';
// Logged-out splash: login in the blue header, 2010 world art on the left, sign-up form on the right.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { signIn, signUp } from '@/lib/keys/session';
import { Footer } from '@/components/Shell';
import { MONTHS } from '@/lib/format';

export const MIN_AGE = 16;

export function LoggedOutHeader() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      const st = await signIn(String(f.get('email')), String(f.get('pw')), f.get('keep') === 'on');
      router.replace(st === 'setup' ? '/welcome' : '/');
    } catch (x) {
      setErr((x as Error).message);
      router.push(`/login?error=${encodeURIComponent((x as Error).message)}`);
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
          <button className="btn" disabled={busy}>{busy ? 'Unlocking…' : 'Log In'}</button>
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

export function Splash() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= 1905; y--) years.push(y);

  async function onSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const first = String(f.get('first')).trim(), last = String(f.get('last')).trim();
    const email = String(f.get('email')).trim(), email2 = String(f.get('email2')).trim();
    const pw = String(f.get('pw'));
    const bm = Number(f.get('bm')), bd = Number(f.get('bd')), by = Number(f.get('by'));
    const sex = String(f.get('sex'));
    if (!first || !last) return setErr('You must provide your full name.');
    if (email.toLowerCase() !== email2.toLowerCase()) return setErr('Your emails do not match. Please try again.');
    if (pw.length < 10) return setErr('Your password must be at least 10 characters long. Longer is better: it also protects your encrypted posts.');
    if (!bm || !bd || !by) return setErr('You must indicate your full birthday to register.');
    if (age(by, bm - 1, bd) < MIN_AGE) return setErr(`You must be at least ${MIN_AGE} years old to use Kithwall.`);
    if (!sex) return setErr('Please select either Male, Female, or Prefer not to say.');
    setBusy(true); setErr(null);
    try {
      // Name, birthday and sex never go to the server in plaintext: they're kept on this device
      // until setup, then saved inside your encrypted profile.
      sessionStorage.setItem('kw.pendingProfile', JSON.stringify({
        name: `${first} ${last}`, birthday: `${by}-${String(bm).padStart(2, '0')}-${String(bd).padStart(2, '0')}`, sex,
      }));
      const { needsConfirmation } = await signUp({ email, password: pw });
      if (needsConfirmation) setSent(email);
      else { await signIn(email, pw, false); router.replace('/welcome'); }
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <LoggedOutHeader />
      <div className="sbody">
        <div className="sin">
          <div className="sl">
            <h2>Kithwall helps you connect and share with the people you actually know &mdash; and nobody else.</h2>
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
                {err && <div className="err" role="alert">{err}</div>}
                <form className="sform" onSubmit={onSignUp} aria-label="Sign up">
                  <table><tbody>
                    <tr><td className="l"><label htmlFor="first">First Name:</label></td><td><input id="first" name="first" type="text" autoComplete="given-name" /></td></tr>
                    <tr><td className="l"><label htmlFor="last">Last Name:</label></td><td><input id="last" name="last" type="text" autoComplete="family-name" /></td></tr>
                    <tr><td className="l"><label htmlFor="email">Your Email:</label></td><td><input id="email" name="email" type="email" autoComplete="email" /></td></tr>
                    <tr><td className="l"><label htmlFor="email2">Re-enter Email:</label></td><td><input id="email2" name="email2" type="email" autoComplete="email" /></td></tr>
                    <tr><td className="l"><label htmlFor="pw">New Password:</label></td><td><input id="pw" name="pw" type="password" autoComplete="new-password" /></td></tr>
                    <tr><td className="l"><label htmlFor="sex">I am:</label></td><td><select id="sex" name="sex" defaultValue=""><option value="">Select Sex:</option><option>Female</option><option>Male</option><option>Prefer not to say</option></select></td></tr>
                    <tr><td className="l">Birthday:</td><td>
                      <select name="bm" aria-label="Month" defaultValue=""><option value="">Month:</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m.slice(0, 3)}</option>)}</select>{' '}
                      <select name="bd" aria-label="Day" defaultValue=""><option value="">Day:</option>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>{' '}
                      <select name="by" aria-label="Year" defaultValue=""><option value="">Year:</option>{years.map((y) => <option key={y}>{y}</option>)}</select>
                      <div style={{ marginTop: 4 }}><a role="button" onClick={() => setWhy((v) => !v)}>Why do I need to provide my birthday?</a></div>
                      {why && <div className="note" style={{ marginTop: 6 }}>We use it to confirm you&rsquo;re old enough to use Kithwall. It stays on your device and inside your encrypted profile &mdash; Kithwall&rsquo;s servers never see it.</div>}
                    </td></tr>
                    <tr><td /><td><button className="btn gr big" disabled={busy}>{busy ? 'Creating your account…' : 'Sign Up'}</button></td></tr>
                  </tbody></table>
                </form>
                <div className="sbot">By clicking Sign Up, you agree to our <Link href="/legal/terms">Terms</Link> and that you have read our <Link href="/legal/privacy">Privacy Policy</Link>.</div>
              </>
            )}
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
