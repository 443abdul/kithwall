'use client';
// Message composer (Kithwall 2): grows with the text, keeps the keyboard open after sending, Enter sends
// on devices with a keyboard (Shift+Enter = new line; on touch screens Enter is a new line), photos and
// videos, reply-to, and a link preview made by our no-log proxy (encrypted with the message).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '@/i18n';
import { useSettings } from '@/lib/settings';
import { signals } from '@/lib/chat/signals';
import { MAX_MESSAGE_CHARS } from '@/lib/messages';
import { loadLinkDraft, type LinkDraft } from '@/lib/feed/linkPreview';
import { IconButton } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useToast } from '@/components/ui/Toast';
import { ChatIcon } from './ChatIcon';
import { firstUrl, snippet } from './chatModel';
import { MAX_ATTACHMENTS, MAX_CHAT_VIDEO_BYTES, type Draft } from './send';

export interface ReplyTarget { id: string; author: string; authorName: string; text: string }

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <li className="k-chat-chip">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : <span className="k-chat-chip-ico"><ChatIcon name="video" /></span>}
      <span className="k-sr-only">{file.name}</span>
      <button type="button" className="k-chat-chip-x" aria-label={t('messages.composer.removeFile', { name: file.name })} onClick={onRemove}>×</button>
    </li>
  );
}

export function ChatComposer({ convId, members, disabled, reply, onCancelReply, onSend, focusKey }: {
  convId: string;
  members: string[];
  disabled: string | null;
  reply: ReplyTarget | null;
  onCancelReply: () => void;
  onSend: (d: Draft) => void;
  focusKey: number;
}) {
  const t = useT();
  const toast = useToast();
  const s = useSettings();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [link, setLink] = useState<{ url: string; draft: LinkDraft | null; loading: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Refocus after a send / when a reply is chosen (keeps the on-screen keyboard up).
  useEffect(() => { if (focusKey) area.current?.focus({ preventScroll: true }); }, [focusKey]);

  // Grow with the content (up to the CSS max height).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  // Link preview for the first link, after a pause in typing. Skipped when photos are attached.
  const url = files.length ? null : firstUrl(text);
  useEffect(() => {
    if (!url || url === dismissed) { setLink(null); return; }
    if (link?.url === url) return;
    const ac = new AbortController();
    const h = setTimeout(() => {
      setLink({ url, draft: null, loading: true });
      loadLinkDraft(url, ac.signal)
        .then((draft) => { if (!ac.signal.aborted) setLink({ url, draft, loading: false }); })
        .catch(() => { if (!ac.signal.aborted) setLink(null); });
    }, 700);
    return () => { clearTimeout(h); ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, dismissed]);

  const typingOn = s.typingIndicator;
  function changed(v: string) {
    setText(v);
    if (!typingOn) return;
    if (v.trim()) signals.typing(convId, members); else signals.stopTyping(convId, members);
  }

  function addFiles(list: FileList | null) {
    const picked = [...(list ?? [])];
    const ok = picked.filter((f) => {
      if (f.type.startsWith('video/') && f.size > MAX_CHAT_VIDEO_BYTES) { toast({ message: t('messages.error.video_too_big'), tone: 'danger' }); return false; }
      if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) { toast({ message: t('messages.error.bad_file'), tone: 'danger' }); return false; }
      return true;
    });
    setFiles((cur) => [...cur, ...ok].slice(0, MAX_ATTACHMENTS));
  }

  function send() {
    const body = text.trim();
    if ((!body && !files.length) || disabled) return;
    if (typingOn) signals.stopTyping(convId, members);
    const draft: Draft = {
      text: body, files,
      ...(reply ? { replyTo: { id: reply.id, author: reply.author } } : {}),
      link: link?.draft && !link.loading ? link.draft : null,
    };
    setText(''); setFiles([]); setLink(null); setDismissed(null);
    onSend(draft);
    area.current?.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    if (coarse) return;
    e.preventDefault();
    send();
  }

  const canSend = !disabled && (!!text.trim() || files.length > 0);
  return (
    <form className="k-chat-composer" onSubmit={(e) => { e.preventDefault(); send(); }} aria-label={t('messages.composer.label')}>
      {disabled ? <p className="k-chat-composer-note k-small k-muted" role="status">{disabled}</p> : null}
      {reply ? (
        <div className="k-chat-replying">
          <ChatIcon name="reply" />
          <span className="k-chat-replying-body">
            <span className="k-chat-replying-to">{t('messages.composer.replyingTo', { name: reply.authorName })}</span>
            <span className="k-chat-replying-text" dir="auto">{snippet(reply.text, 120) || t('messages.preview.attachment')}</span>
          </span>
          <IconButton icon="close" size="sm" label={t('messages.composer.cancelReply')} onClick={onCancelReply} />
        </div>
      ) : null}
      {link ? (
        <div className="k-chat-linkdraft" aria-live="polite">
          {link.loading ? <Spinner size={18} /> : <ChatIcon name="attach" />}
          <span className="k-chat-linkdraft-body">
            <span className="k-chat-linkdraft-title">{link.loading ? t('messages.composer.previewLoading') : (link.draft?.preview.title || link.url)}</span>
            <span className="k-small k-muted">{t('messages.composer.previewNote')}</span>
          </span>
          <IconButton icon="close" size="sm" label={t('messages.composer.removePreview')} onClick={() => { setDismissed(link.url); setLink(null); }} />
        </div>
      ) : null}
      {files.length ? (
        <ul className="k-chat-chips" aria-label={t('messages.composer.attached')}>
          {files.map((f, i) => <FileChip key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
        </ul>
      ) : null}
      <div className="k-chat-composer-row">
        <button type="button" className="k-iconbtn" aria-label={t('messages.composer.attach')} title={t('messages.composer.attach')}
          disabled={!!disabled || files.length >= MAX_ATTACHMENTS} onClick={() => picker.current?.click()}>
          <ChatIcon name="attach" />
        </button>
        <input ref={picker} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <label htmlFor={`k-chat-input-${convId}`} className="k-sr-only">{t('messages.composer.placeholder')}</label>
        <textarea
          id={`k-chat-input-${convId}`}
          ref={area}
          className="k-chat-input"
          rows={1}
          value={text}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder={t('messages.composer.placeholder')}
          disabled={!!disabled}
          enterKeyHint="send"
          onChange={(e) => changed(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => { if (typingOn) signals.stopTyping(convId, members); }}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
        />
        <button type="submit" className="k-chat-send" aria-label={t('messages.composer.send')} title={t('messages.composer.send')}
          disabled={!canSend} onPointerDown={(e) => e.preventDefault()}>
          <ChatIcon name="send" />
        </button>
      </div>
    </form>
  );
}
