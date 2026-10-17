'use client';
// New Message: pick recipients (friends by name, anyone by exact username), write, send.
// One recipient → the one-to-one conversation (reused if it exists); several → a new group.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { useSession } from '@/lib/keys/session';
import { people } from '@/lib/people';
import { createConversation, MAX_MESSAGE_CHARS, openDm } from '@/lib/messages';
import { MAX_ATTACHMENTS } from '@/lib/chat/attach';
import { RecipientPicker } from './RecipientPicker';
import { sendErrorText, sendWithAttachments } from './Composer';
import { MessagesRight } from './ConversationList';
import '@/styles/messages.css';

const VALID = /^[a-z0-9][a-z0-9.]{2,29}$/;

export function NewMessage({ to }: { to?: string }) {
  const { status, userId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prefilled = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== 'ready' || prefilled.current || !to) return;
    prefilled.current = true;
    const u = to.trim().replace(/^@/, '').toLowerCase();
    if (!VALID.test(u)) return;
    void people.byUsername(u).then((row) => {
      if (!row) setErr(`No one has the username @${u}.`);
      else if (row.id !== userId) setIds((cur) => (cur.includes(row.id) ? cur : [...cur, row.id]));
    }).catch(() => setErr('That person couldn’t be found.'));
  }, [status, to, userId]);

  const send = async () => {
    if (busy) return;
    const t = text.trim();
    if (!ids.length) { setErr('Choose who to send this message to.'); return; }
    if (!t && !files.length) { setErr('Write a message first.'); return; }
    setBusy(true); setErr(null);
    try {
      const conv = ids.length === 1 ? await openDm(ids[0]!) : await createConversation(ids, null, name.trim() || undefined);
      await sendWithAttachments(conv, t, files);
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      router.push(`/messages/${conv.id}`);
    } catch (e) {
      setErr(sendErrorText(e));
      setBusy(false);
    }
  };

  return (
    <AppPage active="messages" right={<MessagesRight />}>
      <Title icon="msg" right={<Link href="/messages">&laquo; Back to Messages</Link>}>New Message</Title>
      {to && !VALID.test(to.trim().replace(/^@/, '').toLowerCase()) && <div className="err" role="alert">&ldquo;{to}&rdquo; isn&rsquo;t a valid username.</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <form className="kwm-new" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <table className="form kwm-form"><tbody>
          <tr><td className="l">To:</td><td><RecipientPicker value={ids} onChange={setIds} autoFocus={!to} /></td></tr>
          {ids.length > 1 && (
            <tr><td className="l"><label htmlFor="kwm-gname">Name:</label></td>
              <td><input id="kwm-gname" type="text" maxLength={120} placeholder="Optional — only people in the conversation can see it" value={name} onChange={(e) => setName(e.target.value)} /></td></tr>
          )}
          <tr><td className="l"><label htmlFor="kwm-body">Message:</label></td>
            <td><textarea id="kwm-body" value={text} maxLength={MAX_MESSAGE_CHARS} autoFocus={!!to} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} /></td></tr>
          <tr><td className="l" /><td>
            {files.length > 0 && (
              <ul className="kwm-files">{files.map((f, i) => (
                <li key={`${f.name}-${i}`}><Icon name="photo" /> {f.name}{' '}
                  <button type="button" className="kwm-link" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></li>
              ))}</ul>
            )}
            <div className="kwm-reply-bar">
              <button type="button" className="kwm-link" disabled={files.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}><Icon name="photo" /> Add Photo</button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                setFiles((cur) => [...cur, ...picked].slice(0, MAX_ATTACHMENTS));
                e.target.value = '';
              }} />
              <span className="gray kwm-hint"><Icon name="lock" /> End-to-end encrypted</span>
              <button className={`btn b${busy ? ' dis' : ''}`} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
            </div>
          </td></tr>
        </tbody></table>
      </form>
    </AppPage>
  );
}
