'use client';
// Reply box: Enter sends, Shift+Enter makes a new line. Photos are re-encoded on device,
// encrypted and uploaded before the message is sent; then linked to it (lib/chat/attach.ts).
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useSession } from '@/lib/keys/session';
import { KeyWaitingError, markRead, MAX_MESSAGE_CHARS, sendMessage, type ConversationRow } from '@/lib/messages';
import { discardAttachments, linkAttachments, MAX_ATTACHMENTS, prepareAttachment } from '@/lib/chat/attach';
import { signals } from '@/lib/chat/signals';
import type { FileRef } from '@/lib/types';

export function sendErrorText(e: unknown): string {
  if (e instanceof KeyWaitingError) return 'This conversation\'s key hasn\'t reached this device yet. Try again in a moment.';
  return (e as Error)?.message || 'Your message couldn\'t be sent.';
}

/** Send text + photos to a conversation in the order that keeps attachments readable. */
export async function sendWithAttachments(conv: ConversationRow, text: string, files: File[]): Promise<void> {
  const refs: FileRef[] = [];
  try {
    for (const f of files.slice(0, MAX_ATTACHMENTS)) refs.push(await prepareAttachment(f));
    const id = crypto.randomUUID();
    await sendMessage(conv, { text, ...(refs.length ? { attachments: refs } : {}) }, id);
    if (refs.length) await linkAttachments(refs, id);
  } catch (e) {
    await discardAttachments(refs).catch(() => undefined);
    throw e;
  }
  await markRead(conv).catch(() => undefined);
}

export function Composer({ conv, members, disabled }: { conv: ConversationRow; members: string[]; disabled?: string | null }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const t = text.trim();
    if ((!t && !files.length) || busy || disabled) return;
    setBusy(true); setErr(null);
    signals.stopTyping(conv.id, members);
    try {
      await sendWithAttachments(conv, t, files);
      setText(''); setFiles([]);
      await qc.invalidateQueries({ queryKey: ['messages', conv.id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      area.current?.focus();
    } catch (e) {
      setErr(sendErrorText(e));
    } finally { setBusy(false); }
  };

  return (
    <form className="kwm-reply" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {userId && <Avatar id={userId} size={50} />}
      <div className="kwm-reply-main">
        {err && <div className="err" role="alert">{err}</div>}
        {disabled && <div className="kwm-state">{disabled}</div>}
        <textarea ref={area} aria-label="Reply" placeholder="Reply…" value={text} maxLength={MAX_MESSAGE_CHARS} disabled={!!disabled}
          onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) signals.typing(conv.id, members); else signals.stopTyping(conv.id, members); }}
          onBlur={() => signals.stopTyping(conv.id, members)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }} />
        {files.length > 0 && (
          <ul className="kwm-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}><Icon name="photo" /> {f.name}{' '}
                <button type="button" className="kwm-link" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></li>
            ))}
          </ul>
        )}
        <div className="kwm-reply-bar">
          <button type="button" className="kwm-link" disabled={!!disabled || files.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}>
            <Icon name="photo" /> Add Photo
          </button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            setFiles((cur) => [...cur, ...picked].slice(0, MAX_ATTACHMENTS));
            e.target.value = '';
          }} />
          <span className="gray kwm-hint"><Icon name="lock" /> Encrypted · Enter to send, Shift+Enter for a new line</span>
          <button className={`btn b${busy ? ' dis' : ''}`} disabled={busy || !!disabled}>{busy ? 'Sending…' : 'Reply'}</button>
        </div>
      </div>
    </form>
  );
}
