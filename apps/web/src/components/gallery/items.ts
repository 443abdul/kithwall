// What the gallery shows: every photo and video of one post (or one chat message), in order.
import type { FileRef, PhotoFiles, PostPayload } from '@/lib/types';

export type GalleryItem =
  | { kind: 'photo'; key: string; big: FileRef; med?: FileRef; thumb?: FileRef; files?: PhotoFiles; caption?: string }
  | { kind: 'video'; key: string; file: FileRef; poster?: FileRef; title?: string; duration?: number; w?: number; h?: number };

/** Photos first (in their grid order), then the video: the same order as the post shows them. */
export function postItems(p: PostPayload): GalleryItem[] {
  const out: GalleryItem[] = (p.photos ?? []).map((ph) => ({
    kind: 'photo', key: ph.id || ph.files.big.path, big: ph.files.big, med: ph.files.med, thumb: ph.files.thumb, files: ph.files, caption: ph.caption,
  }));
  if (p.video) {
    out.push({
      kind: 'video', key: p.video.file.path, file: p.video.file, poster: p.video.poster, title: p.video.title,
      duration: p.video.duration, w: p.video.w ?? p.video.poster?.w, h: p.video.h ?? p.video.poster?.h,
    });
  }
  return out;
}

/** Index of the post's video in postItems(), or -1. */
export const postVideoIndex = (p: PostPayload) => (p.video ? (p.photos?.length ?? 0) : -1);

/** Chat attachments: photos (one stored size each) and videos, in the order they were sent. */
export function chatItems(files: FileRef[]): GalleryItem[] {
  return files.map((f): GalleryItem => (f.mime.startsWith('video/')
    ? { kind: 'video', key: f.path, file: f, w: f.w, h: f.h }
    : { kind: 'photo', key: f.path, big: f }));
}
