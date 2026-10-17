'use client';
// Settings → Security & Recovery sections (spec §3.3–3.5, §7).
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { changePassword, getSession, lock, newRecoveryPhrase, useSession, amk } from '@/lib/keys/session';
import { deviceStore } from '@/lib/keys/device';
import { sb } from '@/lib/supabase';
import { useFriendIds } from '@/lib/hooks';
import { people, usePeopleVersion } from '@/lib/people';
import { when } from '@/lib/format';
import {
  MAX_TRUSTEES, MIN_TRUSTEES, approveRecovery, incomingRecoveryRequests, myTrustees, phraseFor, removeTrustees,
  resplitToSameTrustees, rkFromPhrase, setupTrustees, trustedBy, type IncomingRequest, type ShareRow,
} from '@/lib/recovery';
import { NewPasswordRows, readNewPassword } from '@/components/auth/NewPassword';
import { PhraseDisplay } from '@/components/auth/PhraseDisplay';
import { Dialog } from '@/components/auth/Dialog';
import { Avatar } from '@/components/Avatar';

const msg = (x: unknown) => (x as Error).message;

export function PasswordSection() {
  const { email } = useSession();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true); setErr(null); setOk(false);
    try {
      const next = readNewPassword(f, [email ?? '']);
      await changePassword(String(f.get('oldpw') ?? ''), next);
      form.reset(); setOk(true);
    } catch (x) {
      const m = msg(x);
      setErr(/decrypt|bad_password|wrong password|password is not|invalid/i.test(m) && !/stronger|match/.test(m) ? 'Your current password is incorrect.' : m);
    } finally { setBusy(false); }
  }
  return (
    <div className="isec" id="password">
      <h3>Password</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok"><b>Password changed.</b>Use your new password next time you log in. Your recovery key still works.</div>}
      <form className="form" onSubmit={onSubmit} aria-label="Change password">
        <table><tbody>
          <tr><td className="l"><label htmlFor="oldpw">Current:</label></td><td><input id="oldpw" name="oldpw" type="password" autoComplete="current-password" required /></td></tr>
          <NewPasswordRows inputs={[email ?? '']} prefix="chg" />
          <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Changing…' : 'Change Password'}</button>
            <div className="kw-help">Your password unlocks your encryption keys on this device. Changing it re-locks them; nothing is re-uploaded.</div></td></tr>
        </tbody></table>
      </form>
    </div>
  );
}

export function RecoveryKeySection() {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function regenerate() {
    setBusy(true); setErr(null); setConfirm(false);
    try {
      const r = await newRecoveryPhrase();
      await resplitToSameTrustees(r.rk); // trusted friends get pieces of the NEW key
      setPhrase(r.phrase);
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }
  return (
    <div className="isec" id="recovery-key">
      <h3>Recovery Key</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {phrase ? <PhraseDisplay phrase={phrase} onDone={() => { setPhrase(null); setDone(true); }} />
        : <>
          {done && <div className="ok"><b>New recovery key saved.</b>Your old 24 words no longer work.</div>}
          <p style={{ lineHeight: '16px' }}>Your 24-word recovery key is the only way back in if you forget your password (besides trusted friends).
            Kithwall never stores it, so we can&rsquo;t show it again. If you&rsquo;ve lost it, or think someone saw it, make a new one.</p>
          <div className="kw-actions"><button type="button" className="btn" disabled={busy} onClick={() => setConfirm(true)}>{busy ? 'Creating…' : 'Create a New Recovery Key'}</button></div>
        </>}
      {confirm && (
        <Dialog title="Create a New Recovery Key?" onClose={() => setConfirm(false)} buttons={<>
          <button type="button" className="btn b" onClick={() => void regenerate()}>Create New Key</button>
          <button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button></>}>
          Your current 24 words will stop working immediately. You&rsquo;ll need to write down the new ones.
          If you have trusted friends, they&rsquo;ll automatically get pieces of the new key.
        </Dialog>
      )}
    </div>
  );
}

export function TrustedFriendsSection() {
  usePeopleVersion();
  const friends = useFriendIds();
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(2);
  const [source, setSource] = useState<'phrase' | 'new'>('phrase');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPhrase, setNewPhrase] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const load = useCallback(async () => { try { setRows(await myTrustees()); } catch (x) { setErr(msg(x)); } }, []);
  useEffect(() => { void load(); }, [load]);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_TRUSTEES ? p : [...p, id]));
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      if (picked.length < MIN_TRUSTEES) throw new Error(`Choose at least ${MIN_TRUSTEES} friends.`);
      const k = Math.min(Math.max(threshold, 2), picked.length);
      if (source === 'phrase') {
        const words = String(f.get('phrase') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
        let rk: Uint8Array;
        try { rk = await rkFromPhrase(words); } catch { throw new Error('That recovery key doesn\'t match your account. Check the words, or choose "Create a new recovery key".'); }
        await setupTrustees(rk, picked, k);
      } else {
        const r = await newRecoveryPhrase();
        await setupTrustees(r.rk, picked, k);
        setNewPhrase(r.phrase);
      }
      setEditing(false);
      await load();
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }

  const list = (friends.data ?? []).map((id) => ({ id, p: people.person(id) })).sort((a, b) => (a.p?.name ?? '').localeCompare(b.p?.name ?? ''));
  return (
    <div className="isec" id="trusted-setup">
      <h3>Trusted Friends</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {newPhrase && <PhraseDisplay phrase={newPhrase} onDone={() => setNewPhrase(null)} />}
      {!newPhrase && rows && rows.length > 0 && !editing && (
        <>
          <p style={{ lineHeight: '16px', marginBottom: 6 }}>If you lose your password and your recovery key, any <b>{rows[0]!.threshold}</b> of these friends can help you back in.
            None of them can get in alone, and you&rsquo;ll be notified everywhere if anyone tries.</p>
          <div className="list kw-list">{rows.map((r) => (
            <div className="it" key={r.trustee_id}><Avatar id={r.trustee_id} size={32} /><div className="d"><b>{people.person(r.trustee_id)?.name ?? '…'}</b> <span className="gray">since {when(r.created_at)}</span></div></div>
          ))}</div>
          <div className="kw-actions">
            <button type="button" className="btn" onClick={() => { setPicked(rows.map((r) => r.trustee_id)); setThreshold(rows[0]!.threshold); setEditing(true); }}>Change Trusted Friends</button>
            <button type="button" className="btn" onClick={() => setConfirmRemove(true)}>Remove All</button>
          </div>
        </>
      )}
      {!newPhrase && rows && rows.length === 0 && !editing && (
        <>
          <p style={{ lineHeight: '16px' }}>Choose {MIN_TRUSTEES}&ndash;{MAX_TRUSTEES} friends you trust. If you ever lose both your password and your recovery key,
            a few of them together can help you get back in. Each one holds only a useless-on-its-own piece of your recovery key.</p>
          <div className="kw-actions"><button type="button" className="btn b" onClick={() => { setPicked([]); setThreshold(2); setEditing(true); }}>Choose Trusted Friends</button></div>
        </>
      )}
      {editing && (
        <form onSubmit={save} aria-label="Choose trusted friends">
          {list.length < MIN_TRUSTEES
            ? <div className="note">You need at least {MIN_TRUSTEES} friends on Kithwall to use trusted-friend recovery. <Link href="/invite">Invite friends</Link>.</div>
            : <>
              <p style={{ marginBottom: 4 }}><b>1. Pick {MIN_TRUSTEES}&ndash;{MAX_TRUSTEES} friends</b> <span className="gray">({picked.length} chosen)</span></p>
              <div className="kw-pick">{list.map(({ id, p }) => (
                <label key={id}><input type="checkbox" checked={picked.includes(id)} onChange={() => toggle(id)} disabled={!picked.includes(id) && picked.length >= MAX_TRUSTEES} /> {p?.name ?? '…'}</label>
              ))}</div>
              <p style={{ margin: '10px 0 4px' }}><b>2. How many of them must help?</b></p>
              <select aria-label="Friends needed" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                {Array.from({ length: Math.max(1, Math.max(picked.length, 2) - 1) }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n} friends</option>)}
              </select>
              <p style={{ margin: '10px 0 4px' }}><b>3. Unlock your recovery key</b> <span className="gray">(it&rsquo;s split into pieces on this device)</span></p>
              <label className="kw-check"><input type="radio" name="src" checked={source === 'phrase'} onChange={() => setSource('phrase')} /> Enter my 24-word recovery key</label>
              {source === 'phrase' && <textarea name="phrase" rows={3} style={{ width: '100%', maxWidth: 420 }} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="Recovery key" />}
              <label className="kw-check"><input type="radio" name="src" checked={source === 'new'} onChange={() => setSource('new')} /> I don&rsquo;t have it &mdash; create a new recovery key (the old one stops working)</label>
              <div className="kw-actions">
                <button className="btn b" disabled={busy}>{busy ? 'Saving…' : 'Save Trusted Friends'}</button>
                <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>}
        </form>
      )}
      {confirmRemove && (
        <Dialog title="Remove Trusted Friends?" onClose={() => setConfirmRemove(false)} buttons={<>
          <button type="button" className="btn b" onClick={() => { setConfirmRemove(false); void removeTrustees().then(load).catch((x) => setErr(msg(x))); }}>Remove</button>
          <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>Cancel</button></>}>
          Your friends will no longer be able to help you recover your account. Your recovery key still works.
        </Dialog>
      )}
    </div>
  );
}

export function TrusteePanel() {
  usePeopleVersion();
  const [reqs, setReqs] = useState<IncomingRequest[] | null>(null);
  const [owners, setOwners] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [approving, setApproving] = useState<IncomingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    try { const [r, o] = await Promise.all([incomingRecoveryRequests(), trustedBy()]); setReqs(r); setOwners(o); } catch (x) { setErr(msg(x)); }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, [load]);

  async function approve() {
    if (!approving) return;
    setBusy(true); setErr(null);
    try { await approveRecovery(approving); setApproving(null); await load(); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }

  return (
    <div className="isec" id="trusted">
      <h3>Friends Who Trust You</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {owners.length === 0 && <p className="gray">Nobody has chosen you as a trusted friend yet.</p>}
      {owners.length > 0 && <p style={{ marginBottom: 8 }}>You&rsquo;re a trusted friend for <b>{owners.map((o) => people.person(o)?.name ?? '…').join(', ')}</b>.
        You hold a piece of their recovery key that you can&rsquo;t use yourself.</p>}
      {(reqs ?? []).map((r) => {
        const name = people.person(r.owner_id)?.name ?? 'Your friend';
        const open = now >= new Date(r.not_before).getTime();
        return (
          <div className="kw-danger" key={r.id} style={{ background: '#fff' }}>
            <b>{name} is asking for help getting back into their account</b>
            <div className="gray" style={{ marginBottom: 6 }}>Requested {when(r.created_at)} &middot; expires {new Date(r.expires_at).toLocaleString()}</div>
            {r.responded ? <div className="ok" style={{ margin: 0 }}><b>You&rsquo;ve helped.</b>Your piece was sent, locked so that only the device that made this request can use it.</div> : <>
              <p style={{ marginBottom: 6 }}><b>Before you do anything, call {name} or meet them in person.</b> Don&rsquo;t use Kithwall messages, email or texts &mdash;
                if someone took over their account, they could be the one replying. Ask them to read you the six words on their screen. They must match these exactly:</p>
              <div className="kw-words6">{phraseFor(r).join(' ')}</div>
              <p style={{ margin: '6px 0' }}>If the words don&rsquo;t match, or you can&rsquo;t reach {name}, <b>don&rsquo;t approve</b>. Doing nothing is always safe.</p>
              {open ? <button type="button" className="btn b" onClick={() => setApproving(r)}>The Words Match &mdash; Help {name}</button>
                : <p className="gray">For safety you can respond after {new Date(r.not_before).toLocaleString()}.</p>}
            </>}
          </div>
        );
      })}
      {approving && (
        <Dialog title="Help Your Friend Recover?" onClose={() => setApproving(null)} buttons={<>
          <button type="button" className="btn b" disabled={busy} onClick={() => void approve()}>{busy ? 'Sending…' : 'Yes, I Talked to Them'}</button>
          <button type="button" className="btn" onClick={() => setApproving(null)}>Cancel</button></>}>
          Only continue if you spoke to <b>{people.person(approving.owner_id)?.name ?? 'your friend'}</b> by phone or in person and the six words matched.
          Your device will unlock your piece of their recovery key and send it, encrypted, to the device that asked.
        </Dialog>
      )}
    </div>
  );
}

interface Factor { id: string; friendly_name?: string; factor_type: string; status: string; created_at: string }

export function MfaSection() {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState<Factor | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb().auth.mfa.listFactors();
    if (error) { setErr(error.message); return; }
    setFactors(data.all as Factor[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true); setErr(null); setOk(null);
    try {
      for (const f of factors ?? []) if (f.status !== 'verified') await sb().auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await sb().auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
      if (error) throw new Error(error.message);
      const qr = data.totp.qr_code.startsWith('data:') ? data.totp.qr_code : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.totp.qr_code)}`;
      setEnroll({ id: data.id, qr, secret: data.totp.secret });
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!enroll) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s+/g, '');
    setBusy(true); setErr(null);
    try {
      const v = await sb().auth.mfa.challengeAndVerify({ factorId: enroll.id, code });
      if (v.error) throw new Error('That code didn\'t work. Check the time on your phone and try again.');
      setEnroll(null); setOk('Two-step verification is on. Next time you log in on a new device, you\'ll need a code from your app.');
      await load();
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }
  async function turnOff(f: Factor) {
    setBusy(true); setErr(null); setConfirmOff(null);
    try {
      const { error } = await sb().auth.mfa.unenroll({ factorId: f.id });
      if (error) throw new Error(error.message);
      await sb().auth.refreshSession();
      setOk('Two-step verification is off.');
      await load();
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }

  const verified = (factors ?? []).filter((f) => f.status === 'verified');
  return (
    <div className="isec" id="mfa">
      <h3>Two-Step Verification</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      {factors === null ? <p className="gray">Loading&hellip;</p> : enroll ? (
        <form className="form" onSubmit={verify} aria-label="Set up authenticator app">
          <p style={{ lineHeight: '16px', marginBottom: 8 }}>Scan this code with an authenticator app (for example Aegis, 2FAS, Google Authenticator or 1Password), then enter the 6-digit code it shows.</p>
          <div className="kw-row" style={{ alignItems: 'flex-start' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="kw-qr" src={enroll.qr} alt="QR code for your authenticator app" />
            <div style={{ maxWidth: 300 }}>Can&rsquo;t scan? Enter this key instead:<div className="kw-code" style={{ marginTop: 4 }}>{enroll.secret}</div></div>
          </div>
          <table style={{ marginTop: 8 }}><tbody>
            <tr><td className="l"><label htmlFor="mfa-new">Code:</label></td><td><input id="mfa-new" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required style={{ width: 110 }} /></td></tr>
            <tr><td /><td><button className="btn b" disabled={busy}>Turn On</button> <button type="button" className="btn" onClick={() => { void sb().auth.mfa.unenroll({ factorId: enroll.id }); setEnroll(null); }}>Cancel</button></td></tr>
          </tbody></table>
        </form>
      ) : verified.length ? (
        <>
          <p style={{ lineHeight: '16px' }}><span className="kw-pill green">On</span> Logging in on a new device needs your password <b>and</b> a code from your authenticator app.
            Without the code, nobody can even download your encrypted data.</p>
          <div className="list kw-list">{verified.map((f) => (
            <div className="it" key={f.id}><div className="d"><b>{f.friendly_name ?? 'Authenticator app'}</b> <span className="gray">added {when(f.created_at)}</span></div>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirmOff(f)}>Turn Off</button></div>
          ))}</div>
        </>
      ) : (
        <>
          <p style={{ lineHeight: '16px' }}><span className="kw-pill">Off</span> Add a second step to logging in: a 6-digit code from an app on your phone.
            It protects you if someone learns your password.</p>
          <div className="kw-actions"><button type="button" className="btn b" disabled={busy} onClick={() => void start()}>Set Up Authenticator App</button></div>
          <p className="kw-help">Keep your recovery key safe too: if you lose your phone, Kithwall support has to verify you before removing two-step verification.</p>
        </>
      )}
      {confirmOff && (
        <Dialog title="Turn Off Two-Step Verification?" onClose={() => setConfirmOff(null)} buttons={<>
          <button type="button" className="btn b" onClick={() => void turnOff(confirmOff)}>Turn Off</button>
          <button type="button" className="btn" onClick={() => setConfirmOff(null)}>Cancel</button></>}>
          Anyone who learns your password will be able to log in without a code.
        </Dialog>
      )}
    </div>
  );
}

interface SessionRow { id: string; created_at: string; last_active: string; aal: string; user_agent: string | null; is_current: boolean }

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function SessionsSection() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await sb().rpc('my_sessions');
    if (error) setErr(error.message); else setRows(data as SessionRow[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function revoke(id: string) {
    setErr(null);
    const { error } = await sb().rpc('revoke_my_session', { session: id });
    if (error) setErr(error.message); else { setOk('Logged out.'); await load(); }
  }
  async function others() {
    setErr(null);
    const { error } = await sb().auth.signOut({ scope: 'others' });
    if (error) setErr(error.message); else { setOk('All your other sessions are logged out. They\'ll need your password to log in again.'); await load(); }
  }
  return (
    <div className="isec" id="sessions">
      <h3>Where You&rsquo;re Logged In</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      {rows === null ? <p className="gray">Loading&hellip;</p> : (
        <table className="tbl" style={{ width: '100%' }}><thead><tr><th>Device</th><th>Last active</th><th>Signed in</th><th /></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{describeAgent(r.user_agent)}{r.is_current ? <span className="kw-pill green">This device</span> : null}{r.aal === 'aal2' ? <span className="kw-pill">2-step</span> : null}</td>
              <td>{when(r.last_active)}</td><td>{when(r.created_at)}</td>
              <td>{r.is_current ? null : <button type="button" className="kw-link" onClick={() => void revoke(r.id)}>Log out</button>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <div className="kw-actions"><button type="button" className="btn" onClick={() => void others()}>Log Out of All Other Sessions</button></div>
      <p className="kw-help">We don&rsquo;t store IP addresses or locations with your account. Logging a device out stops it from loading anything new.</p>
    </div>
  );
}

export function DeviceSection() {
  const { userId } = useSession();
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => { if (userId) void deviceStore.load(userId).then((v) => { setRemembered(!!v); v?.fill(0); }).catch(() => setRemembered(false)); }, [userId]);
  async function forget() { await deviceStore.clear(); setRemembered(false); setOk('This device has forgotten your keys. You\'ll need your password next time you open Kithwall here.'); }
  async function remember() { if (!userId) return; await deviceStore.save(userId, amk()); setRemembered(true); setOk('This device will stay unlocked until you log out.'); }
  return (
    <div className="isec" id="device">
      <h3>This Device</h3>
      {ok && <div className="ok">{ok}</div>}
      <p style={{ lineHeight: '16px' }}>{remembered
        ? <>Kithwall stays unlocked on this device (&ldquo;Keep me logged in&rdquo;). Your keys are stored here, locked with a key your browser won&rsquo;t let anyone copy.</>
        : <>This device asks for your password each time Kithwall is opened.</>}</p>
      <div className="kw-actions">
        {remembered ? <button type="button" className="btn" onClick={() => void forget()}>Forget This Device</button>
          : remembered === false ? <button type="button" className="btn" onClick={() => void remember()}>Keep Me Logged In Here</button> : null}
        <button type="button" className="btn" onClick={() => { if (getSession().status === 'ready') void lock(); }}>Lock Now</button>
      </div>
    </div>
  );
}
