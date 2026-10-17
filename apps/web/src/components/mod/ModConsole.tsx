'use client';
// Moderation & admin console (staff only). Reports queue with verified disclosures, decisions
// recorded in moderation_actions; admins also appoint moderators and change operator settings.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sb, must } from '@/lib/supabase';
import { me } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { REPORT_REASONS } from '@/lib/report';
import { when } from '@/lib/format';
import { Avatar } from '@/components/Avatar';
import { Dialog } from '@/components/auth/Dialog';
import { payloadText, verifyReport, type ReportRow, type Verification } from '@/components/mod/verify';
import '@/styles/auth.css';

const msg = (x: unknown) => (x as Error).message;
const REASON = Object.fromEntries(REPORT_REASONS) as Record<string, string>;
const who = (id: string | null) => { if (!id) return 'Deleted account'; const p = people.get(id); return p ? `@${p.username}` : '…'; };

export function ModConsole({ role }: { role: 'admin' | 'moderator' }) {
  const [tab, setTab] = useState<'reports' | 'admin'>('reports');
  return (
    <>
      <nav className="tabs2" aria-label="Moderation">
        <a href="#reports" className={tab === 'reports' ? 'on' : ''} onClick={(e) => { e.preventDefault(); setTab('reports'); }}>Reports</a>
        {role === 'admin' && <a href="#admin" className={tab === 'admin' ? 'on' : ''} onClick={(e) => { e.preventDefault(); setTab('admin'); }}>Admin</a>}
      </nav>
      {tab === 'reports' ? <Reports role={role} /> : <Admin />}
    </>
  );
}

function Reports({ role }: { role: 'admin' | 'moderator' }) {
  usePeopleVersion();
  const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = must(await sb().from('reports').select('*').eq('status', status).order('created_at', { ascending: status === 'open' }).limit(200)) as ReportRow[];
      await people.ensure(r.flatMap((x) => [x.reporter_id, x.target_owner_id ?? '']).filter(Boolean));
      setRows(r);
    } catch (x) { setErr(msg(x)); }
  }, [status]);
  useEffect(() => { setRows(null); setSel(null); void load(); }, [load]);
  const cur = rows?.find((r) => r.id === sel) ?? null;
  return (
    <div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="kw-row" style={{ marginBottom: 8 }}>
        <label htmlFor="rs">Show</label>
        <select id="rs" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Open reports</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option>
        </select>
        <button type="button" className="btn" onClick={() => void load()}>Refresh</button>
        <span className="gray">{rows ? `${rows.length} report${rows.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="kw-mod">
        <div className="q" role="list">
          {rows === null ? <p className="gray" style={{ padding: 8 }}>Loading&hellip;</p> : rows.length === 0 ? <p className="gray" style={{ padding: 8 }}>Nothing here. </p> : rows.map((r) => (
            <a key={r.id} href={`#r-${r.id}`} role="listitem" className={sel === r.id ? 'on' : ''} onClick={(e) => { e.preventDefault(); setSel(r.id); }}>
              <b>{REASON[r.reason] ?? r.reason}</b> &middot; {r.target_kind}<br />
              <span className="gray">{who(r.target_owner_id)} &middot; reported {when(r.created_at)}</span>
            </a>
          ))}
        </div>
        <div>{cur ? <ReportDetail key={cur.id} r={cur} role={role} onChanged={() => { setSel(null); void load(); }} /> : <p className="gray">Choose a report to review it.</p>}</div>
      </div>
    </div>
  );
}

function ReportDetail({ r, role, onChanged }: { r: ReportRow; role: 'admin' | 'moderator'; onChanged: () => void }) {
  usePeopleVersion();
  const [v, setV] = useState<Verification | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { action: 'remove' | 'warn' | 'suspend' | 'ban' | 'restore' | 'dismiss' }>(null);
  const [days, setDays] = useState(7);
  const [history, setHistory] = useState<{ action: string; reason: string; created_at: string }[]>([]);

  useEffect(() => {
    void verifyReport(r).then(setV).catch((e) => setV({ state: 'unverifiable', why: msg(e) }));
    if (r.target_owner_id) void sb().from('moderation_actions').select('action, reason, created_at').eq('target_user_id', r.target_owner_id).order('created_at', { ascending: false }).limit(10)
      .then(({ data }) => setHistory((data ?? []) as typeof history));
  }, [r]);

  async function act(kind: NonNullable<typeof confirm>['action']) {
    setBusy(true); setErr(null);
    try {
      const reason = note.trim();
      if (!reason) throw new Error('Write a short decision note first. It is shown to the affected person for warnings and suspensions.');
      if (kind === 'dismiss') {
        must(await sb().from('reports').update({ status: 'dismissed', decision_note: reason }).eq('id', r.id));
      } else if (kind === 'remove') {
        must(await sb().rpc('mod_remove_content', { report: r.id, note: reason }));
      } else {
        if (!r.target_owner_id) throw new Error('This account no longer exists.');
        const expires = kind === 'suspend' ? new Date(Date.now() + days * 86400_000).toISOString() : null;
        must(await sb().from('moderation_actions').insert({ moderator_id: me(), target_user_id: r.target_owner_id, report_id: r.id, action: kind, reason, expires_at: expires }));
        if (r.status === 'open') must(await sb().from('reports').update({ status: 'actioned', decision_note: reason }).eq('id', r.id));
      }
      setConfirm(null);
      onChanged();
    } catch (x) { setErr(msg(x)); setConfirm(null); } finally { setBusy(false); }
  }

  const disclosedText = payloadText(r.disclosed?.plaintext);
  const LABEL = { remove: 'Remove Content', warn: 'Warn', suspend: `Suspend for ${days} day${days > 1 ? 's' : ''}`, ban: 'Ban Account', restore: 'Restore Account', dismiss: 'Dismiss Report' } as const;
  return (
    <div id={`r-${r.id}`}>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="isec">
        <h3>{REASON[r.reason] ?? r.reason} &middot; {r.target_kind} <span className={`kw-pill${r.status === 'open' ? ' red' : ''}`}>{r.status}</span></h3>
        <table><tbody>
          <tr><td className="l">Reported</td><td>{r.target_owner_id ? <span className="kw-row"><Avatar id={r.target_owner_id} size={32} /> {who(r.target_owner_id)}</span> : 'Deleted account'}</td></tr>
          <tr><td className="l">Reporter</td><td>{who(r.reporter_id)} <span className="gray">&middot; {when(r.created_at)}</span></td></tr>
          {r.details && <tr><td className="l">Reporter says</td><td><div className="kw-pre">{r.details}</div></td></tr>}
          {r.decision_note && <tr><td className="l">Decision</td><td>{r.decision_note} <span className="gray">{r.resolved_at ? `· ${when(r.resolved_at)}` : ''}</span></td></tr>}
        </tbody></table>
      </div>
      <div className="isec">
        <h3>Disclosed Content</h3>
        {v === null ? <p className="gray">Verifying&hellip;</p> : v.state === 'verified' ? (
          <div className={v.matches ? 'ok' : 'kw-warn'}>
            <b>{v.matches ? 'Verified: the key opens the stored item and it matches what the reporter saw.' : 'The key opens the stored item, but the reporter\'s copy differs. Showing the verified stored version.'}</b>
            The author&rsquo;s signature checks out.
          </div>
        ) : <div className="kw-danger"><b>Not verified.</b>{v.why}</div>}
        {v?.state === 'verified' && <div className="kw-pre">{payloadText(v.content) || JSON.stringify(v.content, null, 2)}</div>}
        {(v?.state !== 'verified' || !v.matches) && (disclosedText || r.disclosed?.plaintext) ? <>
          <p className="gray" style={{ margin: '6px 0 3px' }}>What the reporter&rsquo;s device sent{v?.state === 'verified' ? '' : ' (unverified)'}:</p>
          <div className="kw-pre">{disclosedText || JSON.stringify(r.disclosed?.plaintext, null, 2)}</div></> : null}
        <p className="kw-help">Photos and attachments are not shown here: only the text and file references the reporter disclosed. Handle child-safety reports by the internal CSAM procedure.</p>
      </div>
      {history.length > 0 && (
        <div className="isec"><h3>Previous Actions on This Account</h3>
          {history.map((h, i) => <div key={i}><b>{h.action}</b> &mdash; {h.reason} <span className="gray">{when(h.created_at)}</span></div>)}
        </div>
      )}
      <div className="isec">
        <h3>Decision</h3>
        <label htmlFor="dn" style={{ display: 'block', marginBottom: 3 }}>Decision note (required; shown to the person for warnings and suspensions):</label>
        <textarea id="dn" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', height: 50 }} />
        <div className="kw-actions">
          {r.status === 'open' && <button type="button" className="btn" disabled={busy} onClick={() => setConfirm({ action: 'dismiss' })}>Dismiss</button>}
          {['post', 'comment', 'photo', 'message'].includes(r.target_kind) && r.status !== 'dismissed' && <button type="button" className="btn b" disabled={busy} onClick={() => setConfirm({ action: 'remove' })}>Remove Content</button>}
          <button type="button" className="btn" disabled={busy || !r.target_owner_id} onClick={() => setConfirm({ action: 'warn' })}>Warn</button>
          <span className="kw-row"><select aria-label="Suspension length" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}</select>
            <button type="button" className="btn" disabled={busy || !r.target_owner_id} onClick={() => setConfirm({ action: 'suspend' })}>Suspend</button></span>
          {role === 'admin' && <button type="button" className="btn" disabled={busy || !r.target_owner_id} onClick={() => setConfirm({ action: 'ban' })}>Ban</button>}
          <button type="button" className="kw-link" disabled={busy || !r.target_owner_id} onClick={() => setConfirm({ action: 'restore' })}>Restore account</button>
        </div>
      </div>
      {confirm && (
        <Dialog title={LABEL[confirm.action]} onClose={() => setConfirm(null)} buttons={<>
          <button type="button" className="btn b" disabled={busy} onClick={() => void act(confirm.action)}>{busy ? 'Saving…' : LABEL[confirm.action]}</button>
          <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button></>}>
          {confirm.action === 'remove' && <>The {r.target_kind} will be deleted for everyone and the report closed. This can&rsquo;t be undone.</>}
          {confirm.action === 'warn' && <>{who(r.target_owner_id)} will see a warning with your note.</>}
          {confirm.action === 'suspend' && <>{who(r.target_owner_id)} won&rsquo;t be able to post, comment or message for {days} day{days > 1 ? 's' : ''}.</>}
          {confirm.action === 'ban' && <>{who(r.target_owner_id)} will be banned until an admin restores the account.</>}
          {confirm.action === 'restore' && <>Lift any suspension or ban on {who(r.target_owner_id)}.</>}
          {confirm.action === 'dismiss' && <>Close this report without action.</>}
          <div className="kw-pre" style={{ marginTop: 6 }}>{note || '(no note yet)'}</div>
        </Dialog>
      )}
    </div>
  );
}

function Admin() {
  usePeopleVersion();
  const qc = useQueryClient();
  const [staff, setStaff] = useState<{ user_id: string; role: string; created_at: string }[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [wait, setWait] = useState('24');

  const load = useCallback(async () => {
    try {
      const s = must(await sb().from('staff_roles').select('user_id, role, created_at').order('created_at')) as { user_id: string; role: string; created_at: string }[];
      await people.ensure(s.map((x) => x.user_id));
      setStaff(s);
      const a = must(await sb().from('app_settings').select('key, value')) as { key: string; value: unknown }[];
      const map = Object.fromEntries(a.map((x) => [x.key, x.value]));
      setSettings(map);
      setWait(String(map.recovery_wait_hours ?? 24));
    } catch (x) { setErr(msg(x)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function appoint(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const u = String(f.get('u') ?? '').trim().replace(/^@/, '').toLowerCase();
    setErr(null); setOk(null);
    try {
      const p = await people.byUsername(u);
      if (!p) throw new Error('Nobody has that username.');
      must(await sb().rpc('grant_staff_role', { target: p.id, new_role: String(f.get('role')) }));
      form.reset(); setOk(`@${p.username} is now a ${String(f.get('role'))}.`); await load();
    } catch (x) { setErr(msg(x)); }
  }
  async function remove(id: string) {
    setErr(null); setOk(null);
    try { must(await sb().rpc('revoke_staff_role', { target: id })); await load(); } catch (x) { setErr(msg(x)); }
  }
  async function setSetting(key: string, value: unknown) {
    setErr(null); setOk(null);
    try {
      must(await sb().from('app_settings').update({ value }).eq('key', key));
      setOk('Saved.'); await load();
      await qc.invalidateQueries({ queryKey: ['setting'] });
    } catch (x) { setErr(msg(x)); }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok">{ok}</div>}
      <div className="isec">
        <h3>Staff</h3>
        <div className="list kw-list">{(staff ?? []).map((s) => (
          <div className="it" key={s.user_id}><Avatar id={s.user_id} size={32} /><div className="d"><b>{who(s.user_id)}</b> <span className="kw-pill">{s.role}</span> <span className="gray">since {when(s.created_at)}</span></div>
            {s.user_id !== me() && <button type="button" className="btn" onClick={() => void remove(s.user_id)}>Remove</button>}</div>
        ))}</div>
        <form className="kw-row" onSubmit={appoint} style={{ marginTop: 8 }} aria-label="Appoint staff">
          <input name="u" type="text" placeholder="username" aria-label="Username" autoCapitalize="none" style={{ width: 180 }} required />
          <select name="role" aria-label="Role" defaultValue="moderator"><option value="moderator">Moderator</option><option value="admin">Admin</option></select>
          <button className="btn b">Appoint</button>
        </form>
        <p className="kw-help">Moderators see reports and the content reporters disclose; nothing else. Admins can also ban, appoint staff and change these settings.</p>
      </div>
      <div className="isec">
        <h3>Operator Settings</h3>
        <label className="kw-check"><input type="checkbox" checked={settings.signups_enabled === true} onChange={(e) => void setSetting('signups_enabled', e.target.checked)} /> Accept new sign-ups</label>
        <label className="kw-check"><input type="checkbox" checked={settings.public_audience_enabled === true} onChange={(e) => void setSetting('public_audience_enabled', e.target.checked)} /> Enable the Public audience (unencrypted posts, Pages, open groups)</label>
        <p className="kw-help" style={{ marginLeft: 20 }}>Before turning Public on, update the Privacy Policy and Terms and give users notice.</p>
        <form className="kw-row" style={{ marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); void setSetting('recovery_wait_hours', Number(wait)); }}>
          <label htmlFor="wait">Trusted-friend recovery waiting period</label>
          <input id="wait" type="number" min={0} max={168} step={1} value={wait} onChange={(e) => setWait(e.target.value)} style={{ width: 60 }} /> hours
          <button className="btn">Save</button>
        </form>
        <p className="kw-help">24 hours is recommended. Shorter waits make it easier for someone who took over a member&rsquo;s email to trick their friends.</p>
      </div>
    </div>
  );
}
