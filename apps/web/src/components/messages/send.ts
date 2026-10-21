'use client';
// Sending a Kithwall 2 chat message. Order that keeps attachments readable (see lib/chat/attach.ts):
//   1. photos are re-encoded on this device (drops EXIF/GPS), videos encrypted in parts; uploaded unlinked
//      voice notes (phase 4) are recorded on this device and encrypted as they are (no transcoding)
//   2. the link preview image (fetched by our no-log proxy) is re-encoded and uploaded the same way
//   3. the message is sealed and inserted
//   4. every uploaded object is linked to the message row (readers retry until then)
// On failure every upload is removed again.
import { deleteMedia, fileRefPaths, linkMedia, MAX_VIDEO_BYTES, uploadLargeEncrypted } from '@/lib/media';
import { prepareAttachment, MAX_ATTACHMENTS } from '@/lib/chat/attach';
import { uploadPreparedImage, type LinkDraft } from '@/lib/feed/linkPreview';
import { KeyWaitingError, markRead, MAX_MESSAGE_CHARS, sendMessage, type ChatPayload, type ConversationRow } from '@/lib/messages';
import type { FileRef } from '@/lib/types';
import { MAX_VOICE_BYTES, MAX_VOICE_SECS, voiceMeta, type VoiceDraft } from '@/lib/chat/voice';

export { MAX_ATTACHMENTS };
export const MAX_CHAT_VIDEO_BYTES = MAX_VIDEO_BYTES;

export interface Draft {
  text: string;
  files: File[];
  replyTo?: { id: string; author: string };
  link?: LinkDraft | null;
  /** A recorded voice note (sent on its own, without text or other files). */
  voice?: VoiceDraft;
}

export type SendErrorCode = 'key_waiting' | 'too_long' | 'video_too_big' | 'bad_file' | 'rate_limited' | 'not_allowed' | 'failed';

export class SendError extends Error {
  constructor(public code: SendErrorCode, message?: string) { super(message ?? code); }
}

function classify(e: unknown): SendError {
  if (e instanceof SendError) return e;
  if (e instanceof KeyWaitingError) return new SendError('key_waiting');
  const m = (e as Error)?.message ?? '';
  if (/too many|a lot of messages|rate limit/i.test(m)) return new SendError('rate_limited', m);
  if (/can't send messages|can’t send messages|42501|not allowed/i.test(m)) return new SendError('not_allowed', m);
  if (/only photos|couldn't be read|20 MB/i.test(m)) return new SendError('bad_file', m);
  return new SendError('failed', m);
}

async function videoSize(file: File): Promise<{ w?: number; h?: number }> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      const done = () => resolve(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : {});
      v.onloadedmetadata = done;
      v.onerror = () => resolve({});
      setTimeout(() => resolve({}), 4000);
      v.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function sendDraft(conv: ConversationRow, draft: Draft, onProgress?: (fraction: number) => void): Promise<string> {
  const text = draft.text.trim();
  if (text.length > MAX_MESSAGE_CHARS) throw new SendError('too_long');
  const files = draft.files.slice(0, MAX_ATTACHMENTS);
  for (const f of files) {
    if (f.type.startsWith('video/') && f.size > MAX_CHAT_VIDEO_BYTES) throw new SendError('video_too_big');
    if (!f.type.startsWith('video/') && !f.type.startsWith('image/')) throw new SendError('bad_file');
  }
  const voice = draft.voice;
  if (voice && (voice.blob.size > MAX_VOICE_BYTES || !(voice.duration > 0) || voice.duration > MAX_VOICE_SECS + 1)) throw new SendError('bad_file');
  const refs: FileRef[] = [];
  let preview: FileRef | undefined;
  const total = files.reduce((n, f) => n + f.size, 0) + (voice?.blob.size ?? 0) || 1;
  let done = 0;
  try {
    if (voice) {
      const bytes = new Uint8Array(await voice.blob.arrayBuffer());
      refs.push(await uploadLargeEncrypted(bytes, voice.mime, {
        onProgress: (loaded, all) => onProgress?.(Math.min(0.99, ((loaded / Math.max(1, all)) * voice.blob.size) / total)),
      }));
      done += voice.blob.size;
    }
    for (const f of files) {
      if (f.type.startsWith('video/')) {
        const dims = await videoSize(f);
        const bytes = new Uint8Array(await f.arrayBuffer());
        const ref = await uploadLargeEncrypted(bytes, f.type || 'video/mp4', {
          onProgress: (loaded, all) => onProgress?.(Math.min(0.99, (done + (loaded / Math.max(1, all)) * f.size) / total)),
        });
        refs.push({ ...ref, ...dims });
      } else {
        refs.push(await prepareAttachment(f));
      }
      done += f.size;
      onProgress?.(Math.min(0.99, done / total));
    }
    if (draft.link?.image) preview = await uploadPreparedImage(draft.link.image);
    const id = crypto.randomUUID();
    const p = draft.link?.preview;
    const payload: ChatPayload = {
      text,
      ...(refs.length ? { attachments: refs } : {}),
      ...(voice ? { voice: voiceMeta(voice) } : {}),
      ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
      ...(p ? {
        link: {
          url: p.url,
          ...(p.title ? { title: p.title.slice(0, 200) } : {}),
          ...(p.description ? { description: p.description.slice(0, 300) } : {}),
          ...(p.site ? { site: p.site.slice(0, 100) } : {}),
          ...(preview ? { image: preview } : {}),
        },
      } : {}),
    };
    await sendMessage(conv, payload, id);
    const paths = [...refs.flatMap(fileRefPaths), ...(preview ? [preview.path] : [])];
    if (paths.length) await linkMedia(paths, { messageId: id });
    onProgress?.(1);
    void markRead(conv).catch(() => undefined);
    return id;
  } catch (e) {
    const paths = [...refs.flatMap(fileRefPaths), ...(preview ? [preview.path] : [])];
    await deleteMedia(paths).catch(() => undefined);
    throw classify(e);
  }
}

/** Every storage object of a message's files (videos are stored in parts). */
export function attachmentObjects(payload: ChatPayload | null): FileRef[] {
  if (!payload) return [];
  const out: FileRef[] = [];
  for (const a of payload.attachments ?? []) for (const p of fileRefPaths(a)) out.push({ ...a, path: p });
  if (payload.link?.image) out.push(payload.link.image);
  return out;
}
