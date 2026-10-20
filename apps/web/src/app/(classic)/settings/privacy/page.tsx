'use client';
// Settings → Privacy (reference vPrivacy), adapted to encrypted audiences (spec §2, scope §2).
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { AppPage } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { Avatar } from '@/components/Avatar';
import { SettingsTabs } from '@/components/auth/SettingsTabs';
import { refreshProfile, useSession } from '@/lib/keys/session';
import { block, myInfo, saveProfileInfo, unblock } from '@/lib/friends';
import { people, usePeopleVersion } from '@/lib/people';
import { useAppSetting } from '@/lib/hooks';
import { sb, must } from '@/lib/supabase';
import { loadSettings, saveSettings, setChatVisible, useSettings, type DefaultAudience } from '@/lib/settings';
import { when } from '@/lib/format';

const msg = (x: unknown) => (x as Error).message;

export default function PrivacySettingsPage() {
  useEffect(() => { document.title = 'Privacy Settings | Kithwall'; void loadSettings().catch(() => undefined); }, []);
  return (
    <AppPage bare>
      <div className="kw-page" style={{ maxWidth: 980, margin: '0 auto' }}>
        <SettingsTabs active="privacy" title="Choose Your Privacy Settings" icon="lock" />
        <div style={{ maxWidth: 760 }}>
          <DirectorySection />
          <SharingSection />
          <ChatSection />
          <BlockSection />
          <EncryptionPanel />
        </div>
      </div>
    </AppPage>
  );
}

function DirectorySection() {
  usePeopleVersion();
  const { profile } = useSession();
  const info = myInfo();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function setDiscoverable(on: boolean) {
    if (!profile) return;
    setBusy(true); setErr(null); setOk(null);
    try {
      const name = info?.name?.trim().slice(0, 80);
      if (on && !name) throw new Error('Add your name in Account Settings first.');
      // The CHECK constraint requires display_name_public to be null unless discoverable.
      const { error } = await sb().from('profiles').update(on ? { discoverable: true, display_name_public: name } : { discoverable: false, display_name_public: null }).eq('id', profile.id);
      if (error) throw new Error(error.message);
      await refreshProfile();
      setOk(on ? 'People can now find you by name in search. Your name is stored unencrypted for this.' : 'You\'re no longer listed. People can still find you by your exact username.');
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }

  async function setHideFriends(hide: boolean) {
    setBusy(true); setErr(null); setOk(null);
    try {
      const cur = myInfo();
      if (!cur) throw new Error('Your profile isn\'t loaded yet. Try again in a moment.');
      await saveProfileInfo({ ...cur, hideFriends: hide });
      setOk(hide ? 'Your friend list is hidden from your friends.' : 'Your friends can see your friend list.');
    } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  }

  return (
    <div className="isec">
      <h3>Basic Directory Information</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      <p className="gray" style={{ marginBottom: 6 }}>Kithwall is private by default: only people who know your username, or follow your invite link, can find you.</p>
      <table><tbody>
        <tr><td className="l" style={{ width: 240 }}><label htmlFor="pv-search">Search for you by name</label></td><td>
          <select id="pv-search" disabled={busy} value={profile?.discoverable ? 'everyone' : 'username'} onChange={(e) => void setDiscoverable(e.target.value === 'everyone')}>
            <option value="username">Only people who know my username</option>
            <option value="everyone">Everyone signed in (lists my name publicly)</option>
          </select>
          {profile?.discoverable ? <div className="kw-help"><Icon name="globe" /> Your name &ldquo;{profile.display_name_public}&rdquo; is <b>not encrypted</b> while you&rsquo;re listed.</div> : null}
        </td></tr>
        <tr><td className="l"><label htmlFor="pv-friends">See your friend list</label></td><td>
          <select id="pv-friends" disabled={busy} value={info?.hideFriends ? 'me' : 'friends'} onChange={(e) => void setHideFriends(e.target.value === 'me')}>
            <option value="friends">Friends Only</option><option value="me">Only Me</option>
          </select>
          <div className="kw-help">Kithwall&rsquo;s servers can always see who is friends with whom (see below); this controls what your friends see.</div>
        </td></tr>
        <tr><td className="l">Send you friend requests</td><td>Anyone who can find you <span className="gray">&middot; block someone to stop them</span></td></tr>
        <tr><td className="l">Send you messages</td><td>Friends Only <span className="gray">&middot; and people in your groups and conversations</span></td></tr>
      </tbody></table>
    </div>
  );
}

function SharingSection() {
  const s = useSettings();
  const pub = useAppSetting('public_audience_enabled');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const publicOn = pub.data === true;
  const choices: [DefaultAudience, string, string, boolean][] = [
    ['friends', 'Friends', 'Encrypted. Your current friends can read it.', true],
    ['self', 'Only Me', 'Encrypted. Only you, on your devices.', true],
    ['public', 'Public', publicOn ? 'Not encrypted. Anyone signed in to Kithwall can read it.' : 'Not available: Kithwall is friends-only for now.', publicOn],
  ];
  async function choose(v: DefaultAudience) {
    setErr(null); setSaved(false);
    try { await saveSettings({ defaultAudience: v }); setSaved(true); } catch (x) { setErr(msg(x)); }
  }
  const rows: [string, string][] = [
    ['Posts by me', s.defaultAudience === 'self' ? 'Only Me' : s.defaultAudience === 'public' ? 'Public' : 'Friends'],
    ['Profile information (birthday, hometown, contact…)', 'Friends'], ['Photos and albums', 'Chosen per album'],
    ['Comments and likes', 'Whoever can see the post'], ['Messages and chat', 'People in the conversation'],
  ];
  return (
    <div className="isec">
      <h3>Sharing on Kithwall {saved ? <span className="gray" style={{ fontWeight: 'normal' }}>Saved.</span> : null}</h3>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="kw-row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div className="preset" style={{ width: 230, flex: 'none' }} role="radiogroup" aria-label="Default audience for new posts">
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Default for new posts</div>
          {choices.map(([v, label, help, enabled]) => (
            <label key={v} className={s.defaultAudience === v ? 'on' : ''} style={enabled ? undefined : { color: '#999', cursor: 'default' }}>
              <input type="radio" name="pre" checked={s.defaultAudience === v} disabled={!enabled} onChange={() => void choose(v)} />{' '}
              <Icon name={v === 'public' ? 'globe' : 'lock'} /> {label}
              <div className="gray" style={{ fontWeight: 'normal', marginTop: 2 }}>{help}</div>
            </label>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <table className="pgrid"><thead><tr><th /><th>Who can see this</th></tr></thead><tbody>
            {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody></table>
          <p className="kw-help" style={{ marginTop: 6 }}>You can still choose a different audience for each post. &ldquo;Friends of Friends&rdquo; doesn&rsquo;t exist on Kithwall:
            it can&rsquo;t be encrypted without giving keys to people you never chose.</p>
        </div>
      </div>
    </div>
  );
}

function ChatSection() {
  const s = useSettings();
  return (
    <div className="isec">
      <h3>Chat</h3>
      <label className="kw-check"><input type="checkbox" checked={s.chatVisible} onChange={(e) => setChatVisible(e.target.checked)} /> Show my friends when I&rsquo;m online</label>
      <p className="kw-help">When this is off you appear offline everywhere, and you won&rsquo;t see who else is online. Messages still arrive.</p>
    </div>
  );
}

function BlockSection() {
  usePeopleVersion();
  const { userId } = useSession();
  const [rows, setRows] = useState<{ blocked: string; created_at: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = must(await sb().from('blocks').select('blocked, created_at').eq('blocker', userId!).order('created_at', { ascending: false })) as { blocked: string; created_at: string }[];
      await people.ensure(r.map((x) => x.blocked));
      setRows(r);
    } catch (x) { setErr(msg(x)); }
  }
  useEffect(() => { if (userId) void load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onBlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const u = String(new FormData(form).get('who') ?? '').trim().replace(/^@/, '').toLowerCase();
    setErr(null); setOk(null);
    if (!u) return;
    setBusy(true);
    try {
      const p = await people.byUsername(u);
      if (!p) throw new Error('Nobody on Kithwall has that username.');
      if (p.id === userId) throw new Error('You can\'t block yourself.');
      await block(p.id);
      form.reset(); setOk(`You blocked @${p.username}. If you were friends, you aren't anymore, and they can't see anything you share.`);
      await load();
    } catch (x) { setErr(/duplicate|23505/.test(msg(x)) ? 'You already blocked that person.' : msg(x)); } finally { setBusy(false); }
  }
  async function onUnblock(id: string) {
    setErr(null); setOk(null);
    try { await unblock(id); await load(); setOk('Unblocked. You\'ll need to send a new friend request to be friends again.'); } catch (x) { setErr(msg(x)); }
  }

  return (
    <div className="isec" id="blocking">
      <h3>Block Lists</h3>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      <p style={{ lineHeight: '16px', marginBottom: 6 }}>Blocked people can&rsquo;t see your profile or anything you share, message you, poke you or send friend requests.
        Blocking someone you were friends with also unfriends them and changes your encryption keys.</p>
      <form onSubmit={onBlock} className="kw-row" aria-label="Block someone">
        <label htmlFor="block-who">Block by username:</label>
        <input id="block-who" name="who" type="text" placeholder="username" autoCapitalize="none" autoComplete="off" style={{ width: 180 }} />
        <button className="btn" disabled={busy}>Block</button>
      </form>
      <div className="list kw-list" style={{ marginTop: 8 }}>
        {rows === null ? <p className="gray">Loading&hellip;</p> : rows.length === 0 ? <p className="gray">You haven&rsquo;t blocked anyone.</p> : rows.map((r) => {
          const p = people.get(r.blocked);
          return (
            <div className="it" key={r.blocked}>
              <Avatar id={r.blocked} size={32} />
              <div className="d"><b>{p ? `@${p.username}` : 'Deleted account'}</b> <span className="gray">blocked {when(r.created_at)}</span></div>
              <button type="button" className="btn" onClick={() => void onUnblock(r.blocked)}>Unblock</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EncryptionPanel() {
  return (
    <div className="isec" id="encryption">
      <h3>What&rsquo;s Encrypted, and What Kithwall Can See</h3>
      <div className="kw-2col">
        <div className="kw-panel">
          <h4><Icon name="lock" /> Encrypted on your device &mdash; Kithwall can&rsquo;t read it</h4>
          <ul>
            <li>Your posts, comments, notes, questions and check-ins</li>
            <li>Your photos, captions and photo tags</li>
            <li>Messages and chat</li>
            <li>Your profile: name, birthday, contact info, likes</li>
            <li>Notification previews, friend-list names, your settings</li>
            <li>Your encryption keys (only wrapped by your password or recovery key)</li>
          </ul>
        </div>
        <div className="kw-panel">
          <h4><Icon name="globe" /> Visible to Kithwall&rsquo;s servers</h4>
          <ul>
            <li>Your email address and username</li>
            <li>Who is friends with whom, who blocks whom</li>
            <li>Who messages whom, when, and roughly how much</li>
            <li>Which groups and events you&rsquo;re in; that you liked or commented on something (not what)</li>
            <li>When things were posted and roughly how big they are</li>
            <li>Your name, only if you list yourself in the directory</li>
            <li>Anything you post as <b>Public</b></li>
          </ul>
        </div>
      </div>
      <div className="kw-panel" style={{ marginTop: 10 }}>
        <h4>Limits we want you to know about</h4>
        <ul>
          <li>Friends can screenshot or copy what you share with them.</li>
          <li>A compromised device or a malicious browser extension can see what you see.</li>
          <li>On the web, Kithwall&rsquo;s server delivers the app&rsquo;s code; a malicious version could steal keys. We publish no third-party scripts and keep the code reviewable.</li>
          <li>There&rsquo;s no forward secrecy yet: someone who later steals your keys could read your past content.</li>
          <li>If you report something, a copy of it and its key are shared with moderators.</li>
        </ul>
        <p style={{ marginTop: 6 }}>Read the <Link href="/legal/privacy">Privacy Policy</Link> or the <Link href="/help#encryption">Help Center</Link> for details.</p>
      </div>
    </div>
  );
}
