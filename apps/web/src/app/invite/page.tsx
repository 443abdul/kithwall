'use client';
// Find Friends / invite (reference vInvite), adapted: we never ask for or upload an address book.
// Share an invite link instead; whoever signs up with it sends you a friend request.
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Avatar } from '@/components/Avatar';
import { sb, must } from '@/lib/supabase';
import { me } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { longDate } from '@/lib/format';
import type { ProfileRow } from '@/lib/types';
import '@/styles/auth.css';

interface Invite { code: string; max_uses: number; uses: number; expires_at: string; created_at: string }

export default function InvitePage() {
  usePeopleVersion();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [uses, setUses] = useState(10);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<ProfileRow | null | undefined>(undefined);

  const load = useCallback(async () => {
    try { setInvites(must(await sb().from('invites').select('*').eq('inviter_id', me()).order('created_at', { ascending: false })) as Invite[]); }
    catch (x) { setErr((x as Error).message); }
  }, []);
  useEffect(() => { document.title = 'Find Friends | Kithwall'; void load(); }, [load]);

  const link = (code: string) => `${location.origin}/welcome?invite=${code}`;

  async function create() {
    setBusy(true); setErr(null);
    try { must(await sb().from('invites').insert({ inviter_id: me(), max_uses: uses })); await load(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  async function revoke(code: string) {
    setErr(null);
    try { must(await sb().from('invites').delete().eq('code', code)); await load(); } catch (x) { setErr((x as Error).message); }
  }
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(link(code)); setCopied(code); setTimeout(() => setCopied(null), 2500); }
    catch { setErr('Couldn\'t copy automatically. Select the link and copy it.'); }
  }
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const u = String(new FormData(e.currentTarget).get('u') ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!u) return;
    setFound(await people.byUsername(u));
  }

  const active = (invites ?? []).filter((i) => new Date(i.expires_at) > new Date() && i.uses < i.max_uses);
  const spent = (invites ?? []).filter((i) => !active.includes(i));
  return (
    <AppPage active="friends" right={
      <RightBox title="Why a link?">
        <p style={{ lineHeight: '15px' }}>Kithwall never asks for your email password or uploads your contacts: your friends&rsquo; addresses are theirs to share.
          Send the link however you like. When someone signs up with it, they send you a friend request.</p>
      </RightBox>
    }>
      <Title icon="friends">Find Friends</Title>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="isec">
        <h3>Invite Friends with a Link</h3>
        <div className="kw-row">
          <label htmlFor="inv-uses">Can be used by</label>
          <select id="inv-uses" value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            {[1, 5, 10, 25, 50].map((n) => <option key={n} value={n}>{n === 1 ? '1 person' : `${n} people`}</option>)}
          </select>
          <button type="button" className="btn b" disabled={busy} onClick={() => void create()}>Create Invite Link</button>
        </div>
        <p className="kw-help">Links expire after 30 days. Anyone with the link can use it, so share it only with people you know.</p>
        <div className="list kw-list" style={{ marginTop: 8 }}>
          {invites === null ? <p className="gray">Loading&hellip;</p> : active.length === 0 ? <p className="gray">No active invite links.</p> : active.map((i) => (
            <div className="it" key={i.code} style={{ flexWrap: 'wrap' }}>
              <div className="d" style={{ flex: 1, minWidth: 220 }}>
                <input type="text" readOnly value={link(i.code)} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} />
                <div className="gray" style={{ marginTop: 2 }}>Used {i.uses} of {i.max_uses} &middot; expires {longDate(i.expires_at)}</div>
              </div>
              <button type="button" className="btn" onClick={() => void copy(i.code)}>{copied === i.code ? 'Copied!' : 'Copy Link'}</button>
              <button type="button" className="btn" onClick={() => void revoke(i.code)}>Revoke</button>
            </div>
          ))}
        </div>
        {spent.length > 0 && <p className="gray" style={{ marginTop: 6 }}>{spent.length} expired or used-up link{spent.length > 1 ? 's' : ''}. <button type="button" className="kw-link" onClick={() => void Promise.all(spent.map((s) => revoke(s.code)))}>Clear</button></p>}
      </div>
      <div className="isec">
        <h3>Find Someone by Username</h3>
        <form className="kw-row" onSubmit={search} aria-label="Find by username">
          <input type="text" name="u" placeholder="username" aria-label="Username" autoCapitalize="none" autoComplete="off" style={{ width: 200 }} />
          <button className="btn">Find</button>
        </form>
        {found === null && <p className="gray" style={{ marginTop: 6 }}>Nobody has that exact username. Usernames are only found when typed exactly.</p>}
        {found && (
          <div className="list kw-list" style={{ marginTop: 6 }}>
            <div className="it"><Avatar id={found.id} size={50} /><div className="d"><Link className="big" href={`/${found.username}`}><b>{people.person(found.id)?.name ?? found.username}</b></Link><div className="gray">@{found.username}</div></div></div>
          </div>
        )}
        <p className="kw-help" style={{ marginTop: 6 }}>Looking for someone by name? Use the search box at the top; people only appear there if they chose to be listed.</p>
      </div>
    </AppPage>
  );
}
