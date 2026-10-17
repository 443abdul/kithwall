'use client';
// Settings → Account (reference vAccount): name, username, email, notification emails, language,
// Download Your Information, and account deletion with proof-of-key (spec §3.9).
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { signChallenge } from '@kithwall/crypto';
import { AppPage } from '@/components/Shell';
import { SettingsTabs } from '@/components/auth/SettingsTabs';
import { Dialog } from '@/components/auth/Dialog';
import { identity, refreshProfile, signOut, useSession } from '@/lib/keys/session';
import { myInfo, saveProfileInfo } from '@/lib/friends';
import { usePeopleVersion } from '@/lib/people';
import { sb } from '@/lib/supabase';
import { authedPost } from '@/lib/auth/api';
import { buildExport, saveBlob, type ExportSummary } from '@/lib/export';
import { loadSettings, saveSettings, useSettings, type EmailPrefs } from '@/lib/settings';
import { deviceStore } from '@/lib/keys/device';

const msg = (x: unknown) => (x as Error).message;
const USERNAME_RE = /^[a-z0-9][a-z0-9.]{2,29}$/;

export default function AccountSettingsPage() {
  useEffect(() => { document.title = 'Account Settings | Kithwall'; }, []);
  return (
    <AppPage bare>
      <div className="kw-page" style={{ maxWidth: 980, margin: '0 auto' }}>
        <SettingsTabs active="account" title="My Account" icon="info" />
        <div style={{ maxWidth: 720 }}>
          <GeneralSection />
          <NotificationsSection />
          <ExportSection />
          <DeleteSection />
        </div>
      </div>
    </AppPage>
  );
}

function GeneralSection() {
  usePeopleVersion();
  const { profile, email } = useSession();
  const info = myInfo();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function setName(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim().replace(/\s+/g, ' ');
    setErr(null); setOk(null);
    if (!name || name.length > 80) { setErr('Please enter your name (up to 80 characters).'); return; }
    setBusy('name');
    try {
      const cur = myInfo();
      await saveProfileInfo({ ...(cur ?? { name }), name });
      // If I'm listed in the directory, the public directory name follows my real name.
      if (profile?.discoverable) {
        const { error } = await sb().from('profiles').update({ display_name_public: name }).eq('id', profile.id);
        if (error) throw new Error(error.message);
        await refreshProfile();
      }
      setOk('Your name was changed. Only your friends can see it' + (profile?.discoverable ? ' (and people searching the directory).' : '.'));
    } catch (x) { setErr(msg(x)); } finally { setBusy(null); }
  }

  async function setUsername(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const u = String(new FormData(e.currentTarget).get('un') ?? '').trim().toLowerCase();
    setErr(null); setOk(null);
    if (!USERNAME_RE.test(u)) { setErr('Usernames are 3–30 characters: letters, numbers and periods, starting with a letter or number.'); return; }
    if (!profile || u === profile.username) return;
    setBusy('un');
    try {
      const { error } = await sb().from('profiles').update({ username: u }).eq('id', profile.id);
      if (error) throw new Error(error.code === '23505' ? 'That username is taken.' : error.message);
      await refreshProfile();
      setOk(`Your profile is now at /${u}. Old links to /${profile.username} stop working.`);
    } catch (x) { setErr(msg(x)); } finally { setBusy(null); }
  }

  const row = (l: string, v: ReactNode, id?: string) => <tr id={id}><td className="l" style={{ width: 140 }}>{l}</td><td>{v}</td></tr>;
  return (
    <div className="isec">
      <h3>Settings</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      <table><tbody>
        {row('Name', <form onSubmit={setName} className="kw-row"><input type="text" name="name" aria-label="Name" defaultValue={info?.name ?? ''} key={info?.name ?? ''} maxLength={80} style={{ width: 220 }} />
          <button className="btn" disabled={busy === 'name'}>Change</button><span className="kw-help" style={{ width: '100%' }}>Encrypted: only your friends can see it.</span></form>)}
        {row('Username', <form onSubmit={setUsername} className="kw-row"><span className="gray">kithwall/</span><input type="text" name="un" aria-label="Username" defaultValue={profile?.username ?? ''} key={profile?.username ?? ''} maxLength={30} autoCapitalize="none" style={{ width: 140 }} />
          <button className="btn" disabled={busy === 'un'}>Save</button><span className="kw-help" style={{ width: '100%' }}>Visible to everyone signed in. Changing it breaks old links to your profile.</span></form>)}
        {row('Email', <><b>{email}</b><div className="kw-help">Changing your email isn&rsquo;t possible yet: your email is part of how your password unlocks your encryption keys,
          so it can&rsquo;t change without a careful re-keying step we haven&rsquo;t built. <Link href="/help#email">Learn more</Link>.</div></>)}
        {row('Password', <><Link href="/settings/security#password">Change your password</Link> &middot; <Link href="/settings/security#mfa">Two-step verification</Link> &middot; <Link href="/settings/security#recovery-key">Recovery key</Link></>)}
        {row('Language', <><select aria-label="Language" defaultValue="en-US"><option value="en-US">English (US)</option></select>
          <div className="kw-help">More languages are coming.</div></>)}
        {row('Linked Accounts', <span className="gray">None. Kithwall never connects to other services.</span>)}
      </tbody></table>
    </div>
  );
}

function NotificationsSection() {
  const s = useSettings();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void loadSettings().catch((x) => setErr(msg(x))); }, []);
  async function set(k: keyof EmailPrefs, v: boolean) {
    setErr(null); setSaved(false);
    try { await saveSettings({ email: { ...s.email, [k]: v } }); setSaved(true); } catch (x) { setErr(msg(x)); }
  }
  const box = (k: keyof EmailPrefs, label: string) => (
    <label className="kw-check" key={k}><input type="checkbox" checked={s.email[k]} onChange={(e) => void set(k, e.target.checked)} /> {label}</label>
  );
  return (
    <div className="isec" id="notifications">
      <h3>Email Notifications {saved ? <span className="gray" style={{ fontWeight: 'normal' }}>Saved.</span> : null}</h3>
      {err && <div className="err" role="alert">{err}</div>}
      <p style={{ lineHeight: '16px', marginBottom: 4 }}>Emails from Kithwall never contain names, messages or anything you share &mdash; just &ldquo;You have new activity on Kithwall&rdquo;.
        These choices are stored encrypted, so only your devices can read them.</p>
      {box('friendRequests', 'Someone sends me a friend request')}
      {box('messages', 'I get a new message')}
      {box('activity', 'Other activity (comments, tags, pokes) — a daily summary at most')}
      {box('security', 'Security alerts (recovery requests, trusted-friend requests) — recommended')}
    </div>
  );
}

function ExportSection() {
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  async function go() {
    setBusy(true); setErr(null); setSummary(null);
    try {
      const r = await buildExport((s, d, t) => setStep(d && t ? `${s} (${d} of ${t})` : s));
      saveBlob(r.blob, r.filename);
      setSummary(r.summary);
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); setStep(''); }
  }
  return (
    <div className="isec" id="download">
      <h3>Download Your Information</h3>
      {err && <div className="err" role="alert">{err}</div>}
      <p style={{ lineHeight: '16px' }}>Get a copy of your profile, friends, posts, comments, photos and messages. Everything is decrypted <b>on this device</b> and saved as a ZIP file;
        nothing decrypted is sent anywhere. Keep the file safe: it isn&rsquo;t encrypted.</p>
      <div className="kw-actions">
        <button type="button" className="btn b" disabled={busy} onClick={() => void go()}>{busy ? 'Preparing…' : 'Download Your Information'}</button>
        {busy && <span className="gray" aria-live="polite">{step}&hellip;</span>}
      </div>
      {summary && <div className="ok" style={{ marginTop: 8 }}><b>Your download is ready.</b>
        {summary.posts} posts, {summary.comments} comments, {summary.photos} photos and {summary.messages} messages ({(summary.bytes / 1048576).toFixed(1)} MB).
        {summary.skipped ? ` ${summary.skipped} item(s) couldn't be decrypted yet and are listed without content.` : ''}</div>}
    </div>
  );
}

function DeleteSection() {
  const { profile } = useSession();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function del() {
    setBusy(true); setErr(null);
    try {
      const { data, error } = await sb().rpc('create_key_challenge', { purpose: 'delete_account' });
      if (error) throw new Error(error.code === 'P0429' ? 'Too many attempts. Try again in an hour.' : error.message);
      const ch = (Array.isArray(data) ? data[0] : data) as { id: string; nonce: string } | undefined;
      if (!ch) throw new Error('Could not start the confirmation. Please try again.');
      const signature = signChallenge(identity().signPriv, ch.nonce);
      await authedPost('/api/account/delete', { challengeId: ch.id, signature });
      await deviceStore.clear().catch(() => undefined);
      await signOut().catch(() => undefined);
      location.href = '/?deleted=1';
    } catch (x) { setErr(msg(x)); setBusy(false); }
  }

  return (
    <div className="isec" id="delete">
      <h3>Delete Account</h3>
      <p style={{ lineHeight: '16px', marginBottom: 6 }}>Deleting your account is immediate and permanent. Your profile, posts, photos, comments, messages you sent and your keys are erased.
        Because your keys are destroyed, any copies left in backups (kept up to 7 days) can never be decrypted.</p>
      <button type="button" className="btn" onClick={() => { setOpen(true); setTyped(''); setAck(false); setErr(null); }}>Delete My Account</button>
      {open && (
        <Dialog title="Permanently Delete Account" onClose={() => { if (!busy) setOpen(false); }} buttons={<>
          <button type="button" className="btn b" disabled={busy || !ack || typed.trim().toLowerCase() !== (profile?.username ?? '').toLowerCase()} onClick={() => void del()}>{busy ? 'Deleting…' : 'Delete My Account'}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></>}>
          {err && <div className="err" role="alert">{err}</div>}
          <p style={{ marginBottom: 6 }}>This can&rsquo;t be undone. You might want to <a href="#download" onClick={() => setOpen(false)}>download your information</a> first.</p>
          <label className="kw-check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand everything will be deleted for good.</label>
          <label htmlFor="del-confirm" style={{ display: 'block', margin: '6px 0 3px' }}>Type your username (<b>{profile?.username}</b>) to confirm:</label>
          <input id="del-confirm" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="none" autoComplete="off" style={{ width: '100%' }} />
          <p className="kw-help" style={{ marginTop: 6 }}>Your device will sign a one-time confirmation with your identity key, so someone who only stole your password session can&rsquo;t do this.</p>
        </Dialog>
      )}
    </div>
  );
}
