'use client';
// Write / edit a note (reference vNewNote): title, body, tagged friends, audience.
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AudienceSelect, toAudience } from '@/components/feed/AudienceSelect';
import { FriendPicker } from './bits';
import { createPost, editPost } from '@/lib/content';
import { clean, notifySafe, snippet } from '@/lib/feed/feed';
import { useFriendIds } from '@/lib/hooks';
import type { PostPayload, PostRow } from '@/lib/types';

const MAX_BODY = 50_000;

export function NoteEditor({ existing }: { existing?: { row: PostRow; payload: PostPayload } }) {
  const router = useRouter();
  const qc = useQueryClient();
  const friends = useFriendIds();
  const n = existing?.payload.note;
  const [title, setTitle] = useState(n?.title ?? '');
  const [body, setBody] = useState(n?.body ?? '');
  const [tagged, setTagged] = useState<string[]>(n?.tagged ?? []);
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setErr('Please give your note a title.'); return; }
    if (!body.trim()) { setErr('Your note is empty.'); return; }
    setBusy(true); setErr(null);
    const note = { title: title.trim().slice(0, 200), body: body.slice(0, MAX_BODY), tagged };
    try {
      let id: string;
      if (existing) {
        await editPost(existing.row, clean({ ...existing.payload, note }));
        id = existing.row.id;
      } else {
        const row = await createPost({ kind: 'note', payload: { note }, audience: toAudience(aud) });
        id = row.id;
      }
      const before = new Set(n?.tagged ?? []);
      for (const t of tagged) if (!before.has(t)) await notifySafe(t, 'mention', 'post', id, snippet(`Tagged in the note: ${note.title}`, 80));
      await qc.invalidateQueries({ queryKey: ['kind'] });
      await qc.invalidateQueries({ queryKey: ['post', id] });
      await qc.invalidateQueries({ queryKey: ['feed'] });
      router.push(`/notes/${id}`);
    } catch (x) { setErr((x as Error).message || 'Couldn’t save your note.'); setBusy(false); }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      {err && <div className="err" role="alert">{err}</div>}
      <table className="form kw-noteform"><tbody>
        <tr><td className="l"><label htmlFor="nt">Title:</label></td><td><input id="nt" type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', maxWidth: 420 }} /></td></tr>
        <tr><td className="l"><label htmlFor="nb">Body:</label></td><td><textarea id="nb" value={body} maxLength={MAX_BODY} onChange={(e) => setBody(e.target.value)} style={{ width: '100%', maxWidth: 420, height: 220 }} /></td></tr>
        <tr><td className="l">Tag friends:</td><td style={{ maxWidth: 420 }}><FriendPicker friends={friends.data ?? []} value={tagged} onChange={setTagged} max={20} /></td></tr>
        {!existing && <tr><td className="l"><label htmlFor="na">Privacy:</label></td><td><AudienceSelect id="na" value={aud} onChange={setAud} /></td></tr>}
        <tr><td /><td><button className="btn b" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save Note' : 'Publish'}</button>{' '}
          <Link className="btn" href={existing ? `/notes/${existing.row.id}` : '/notes'}>{existing ? 'Cancel' : 'Discard'}</Link></td></tr>
      </tbody></table>
    </form>
  );
}
