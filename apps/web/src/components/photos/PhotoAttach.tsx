'use client';
// Publisher "Photo" tab. Owned by the photos work; used by the feed/profile publisher.
// Contract: user picks image files; on post, call `upload()` (exposed via ref) which uploads them into
// the "Wall Photos" album and resolves to the payload entries for PostPayload.photos.
import type { PostPayload } from '@/lib/types';

export type AttachedPhotos = NonNullable<PostPayload['photos']>;
export interface PhotoAttachHandle { hasFiles(): boolean; upload(): Promise<AttachedPhotos>; clear(): void }

export function PhotoAttach(_props: { onChange?: (count: number) => void; handleRef: { current: PhotoAttachHandle | null } }) {
  return null;
}
