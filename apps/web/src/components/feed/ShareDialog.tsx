'use client';
// Share: only links (re-posted as my own link) and public posts. Friends-only posts are never
// re-shared, because that would hand them to people outside the author's chosen audience.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog } from '@/components/social/Dialog';
import { AudienceSelect, toAudience } from './AudienceSelect';
import { LinkCard } from './Attachments';
import { shareLink, sharePublicPost } from '@/lib/feed/feed';
import type { PostPayload, PostRow } from '@/lib/types';

export function canShare(row: PostRow, payload: PostPayload): boolean {
  return row.is_public || !!payload.link;
}

export function ShareDialog({ row, payload, onClose }: { row: PostRow; payload: PostPayload; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (payload.link) await shareLink(payload.link, text, toAudience(aud));
      else await sharePublicPost(row, text, toAudience(aud));
      await qc.invalidateQueries({ queryKey: ['feed'] });
      await qc.invalidateQueries({ queryKey: ['wall'] });
      setDone(true);
    } catch (e) { setErr((e as Error).message || 'Couldn’t share this.'); } finally { setBusy(false); }
  };
  if (done) {
    return <Dialog title="Shared" onClose={onClose} buttons={<button type="button" className="btn b" onClick={onClose}>Okay</button>}>
      It&rsquo;s on your Wall now.
    </Dialog>;
  }
  return (
    <Dialog title={payload.link ? 'Share This Link' : 'Share This Post'} onClose={onClose} buttons={<>
      <AudienceSelect value={aud} onChange={setAud} />{' '}
      <button type="button" className="btn b" disabled={busy} onClick={() => void go()}>{busy ? 'Sharing…' : 'Share'}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
    </>}>
      {err && <div className="err" role="alert">{err}</div>}
      <textarea data-autofocus className="kw-sharebox" placeholder="Write something..." aria-label="Say something about this"
        value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
      {payload.link ? <LinkCard link={payload.link} /> : <div className="gray" style={{ marginTop: 6 }}>{(payload.text ?? '').slice(0, 200)}</div>}
      {!payload.link && <p className="gray small" style={{ marginTop: 6 }}>Only public posts can be shared. Your share links back to the original.</p>}
    </Dialog>
  );
}
