'use client';
// Text, previews and system lines for decrypted messages (Kithwall 2).
import type { TFunction } from '@/i18n';
import type { ChatPayload } from '@/lib/messages';
import type { Decrypted } from '@/lib/content';
import { durationKey } from '@/lib/chat/ephemeral';
import { linkify, snippet } from './chatModel';
import { clockParts, readVoiceMeta } from '@/lib/chat/voice';

export function MessageText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) => ('href' in p
        ? <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">{p.text}</a>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

const isVideo = (mime: string) => mime.startsWith('video/');

/** "named the chat …", "added Ann and Ben", … (without the actor, who is shown first). */
export function eventLine(p: ChatPayload, actor: string, nameOf: (id: string) => string, list: (xs: string[]) => string, t: TFunction): string | null {
  const e = p.event;
  if (!e) return null;
  const ids = 'ids' in e && Array.isArray(e.ids) ? e.ids : [];
  switch (e.kind) {
    case 'rename': return e.name ? t('messages.event.renamed', { name: actor, title: e.name }) : t('messages.event.unnamed', { name: actor });
    case 'added': return t('messages.event.added', { name: actor, people: list(ids.map(nameOf)) });
    case 'removed': return t('messages.event.removed', { name: actor, people: list(ids.map(nameOf)) });
    case 'left': return t('messages.event.left', { name: actor });
    case 'timer': return e.secs
      ? t('ephemeral.event.set', { name: actor, duration: t(durationKey(e.secs)) })
      : t('ephemeral.event.off', { name: actor });
    case 'call':
      if (e.state === 'ringing') return t('calls.event.ringing', { name: actor });
      if (e.state === 'missed') return e.mine ? t('calls.event.noAnswer', { name: actor }) : t(e.video ? 'calls.event.missedVideo' : 'calls.event.missedVoice', { name: actor });
      return t(e.video ? 'calls.event.video' : 'calls.event.voice', { name: actor });
    // Server notices about who may read and hand out this chat's keys (security re-review R-K-2).
    case 'roster': {
      const person = nameOf(e.member);
      if (e.what === 'owner') return t('security.roster.owner', { person });
      if (e.what === 'admin') return t('security.roster.admin', { name: actor, person });
      return person === actor ? t('security.roster.joined', { person }) : t('security.roster.added', { name: actor, person });
    }
    default: return null;
  }
}

/** One-line preview of a message for the conversation list / reply quotes. */
export function previewText(d: Decrypted<ChatPayload>, t: TFunction): string {
  if (!d.ok) return d.reason === 'waiting' ? t('messages.preview.sealed') : t('messages.preview.unverified');
  const v = d.value;
  const atts = v.attachments ?? [];
  if (v.text?.trim()) return snippet(v.text);
  const voice = readVoiceMeta(v.voice);
  if (voice) {
    const { m, s } = clockParts(voice.duration);
    return t('voice.preview', { duration: `${m}:${String(s).padStart(2, '0')}` });
  }
  if (atts.length) {
    const videos = atts.filter((a) => isVideo(a.mime)).length;
    if (videos && videos === atts.length) return t('messages.preview.video', { count: videos });
    return t('messages.preview.photo', { count: atts.length });
  }
  if (v.link) return v.link.title ? snippet(v.link.title) : v.link.url;
  return '';
}
