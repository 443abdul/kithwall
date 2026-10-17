'use client';
// Profile action buttons: Edit Profile · Add as Friend · Respond to Friend Request · Friend Request
// Sent · Message · Poke · ⚙ (Unfriend, Block, Report profile).
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { ReportDialog } from '@/components/ReportDialog';
import { ConfirmDialog, Dialog } from '@/components/social/Dialog';
import { acceptFriend, block, cancelRequest, ignoreRequest, poke, sendFriendRequest } from '@/lib/friends';
import { reconcileAudiences, unfriendFully } from '@/lib/social/graph';
import type { ProfileCtx } from './ProfileFrame';

export function AddFriendDialog({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone?: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await sendFriendRequest(id, note.trim().slice(0, 500) || undefined); onDone?.(); onClose(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title={`Add ${name} as a friend?`} onClose={onClose} buttons={<>
      <button type="button" className="btn b" disabled={busy} onClick={() => void go()}>{busy ? 'Sending…' : 'Send Request'}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
    </>}>
      {err && <div className="err" role="alert">{err}</div>}
      <p style={{ marginBottom: 6 }}>{name} will have to confirm that you are friends.</p>
      <label htmlFor="kw-note"><b>Add a personal message</b> <span className="gray">(optional, encrypted so only {name} can read it)</span></label>
      <textarea id="kw-note" data-autofocus className="kw-sharebox" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
    </Dialog>
  );
}

export function ProfileButtons({ ctx }: { ctx: ProfileCtx }) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'add' | 'unfriend' | 'block' | 'report' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [poked, setPoked] = useState(false);
  const name = ctx.person?.name ?? ctx.row.display_name_public ?? ctx.row.username;
  const first = name.split(' ')[0];
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['friends'] }), qc.invalidateQueries({ queryKey: ['requests'] }),
    qc.invalidateQueries({ queryKey: ['wall'] }), qc.invalidateQueries({ queryKey: ['feed'] }),
  ]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    await refresh();
  };
  const msg = <Link className="btn" href={`/messages/new?to=${encodeURIComponent(ctx.row.username)}`}><Icon name="msg" /> Message</Link>;

  if (ctx.isMe) return <div className="bs"><Link className="btn" href="/settings/profile">Edit Profile</Link></div>;
  return (
    <div className="bs">
      {err && <div className="err" role="alert" style={{ width: '100%' }}>{err}</div>}
      {ctx.rel === 'friends' && <>
        {msg}
        <button type="button" className="btn" disabled={poked} onClick={() => void act(async () => { await poke(ctx.id); setPoked(true); })}>{poked ? 'Poked' : 'Poke'}</button>
      </>}
      {ctx.rel === 'received' && <>
        <button type="button" className="btn b" onClick={() => void act(() => acceptFriend(ctx.id))}>Confirm Friend Request</button>
        <button type="button" className="btn" onClick={() => void act(() => ignoreRequest(ctx.id))}>Not Now</button>
        {msg}
      </>}
      {ctx.rel === 'sent' && <>
        <span className="btn dis"><Icon name="friends" /> Friend Request Sent</span>
        <button type="button" className="btn" onClick={() => void act(() => cancelRequest(ctx.id))}>Cancel Request</button>
        {msg}
      </>}
      {ctx.rel === 'none' && <>
        <button type="button" className="btn" onClick={() => setDialog('add')}><Icon name="friends" /> Add as Friend</button>
        {msg}
      </>}
      <span className="kw-gear">
        <button type="button" className="btn" aria-label="More options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>&#9881; &#9662;</button>
        {menu && (
          <div className="kw-menu" role="menu" onMouseLeave={() => setMenu(false)}>
            {ctx.rel === 'friends' && <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog('unfriend'); }}>Unfriend {first}</button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog('block'); }}>Block {first}</button>
            <button type="button" role="menuitem" onClick={() => { setMenu(false); setDialog('report'); }}>Report this profile</button>
          </div>
        )}
      </span>
      {dialog === 'add' && <AddFriendDialog id={ctx.id} name={name} onClose={() => setDialog(null)} onDone={() => void refresh()} />}
      {dialog === 'unfriend' && (
        <ConfirmDialog title={`Unfriend ${name}?`} confirmLabel="Unfriend" onClose={() => setDialog(null)}
          onConfirm={async () => { await unfriendFully(ctx.id); await refresh(); }}>
          <p style={{ marginBottom: 6 }}>{name} will be removed from your friends and from your friend lists.</p>
          <p className="gray">Your device will also change your encryption key and share the new one with your remaining friends,
            so {first} won&rsquo;t be able to read anything you post from now on. {first} won&rsquo;t be notified.</p>
        </ConfirmDialog>
      )}
      {dialog === 'block' && (
        <ConfirmDialog title={`Block ${name}?`} confirmLabel="Block" onClose={() => setDialog(null)}
          onConfirm={async () => { await block(ctx.id); await reconcileAudiences(true); await refresh(); }}>
          <p style={{ marginBottom: 6 }}>{first} won&rsquo;t be able to see your profile, find you, message you or post on your Wall. If you&rsquo;re friends, this also unfriends {first}.</p>
          <p className="gray">Your encryption key will be changed so {first} can&rsquo;t read anything new. You can unblock people in your privacy settings.</p>
        </ConfirmDialog>
      )}
      {dialog === 'report' && <ReportDialog kind="profile" id={ctx.id} onClose={() => setDialog(null)}
        disclosure={{ plaintext: { username: ctx.row.username, name, bio: ctx.person?.info?.bio ?? null } }} />}
    </div>
  );
}
