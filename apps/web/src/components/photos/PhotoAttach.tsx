'use client';
// Publisher "Photo" tab. Owned by the photos work; used by the feed/profile publisher.
// Contract: user picks image files; on post, call `upload()` (exposed via ref) which uploads them into
// the "Wall Photos" album and resolves to the payload entries for PostPayload.photos.
// `upload({ audience })` optionally gives the photos the post's audience (e.g. Only Me or a list)
// so the album copy is never visible to more people than the post itself.
import '@/styles/photos.css';
import { useEffect, useRef, useState } from 'react';
import type { PostPayload } from '@/lib/types';
import { addPhotos, systemAlbum, type AlbumAudience } from '@/lib/photos';
import { PhotoPicker, revokePicked, usePicked } from './PhotoPicker';

export type AttachedPhotos = NonNullable<PostPayload['photos']>;
export interface PhotoAttachHandle { hasFiles(): boolean; upload(opts?: { audience?: AlbumAudience }): Promise<AttachedPhotos>; clear(): void }

export const MAX_ATTACH = 20;

export function PhotoAttach({ onChange, handleRef }: { onChange?: (count: number) => void; handleRef: { current: PhotoAttachHandle | null } }) {
  const [items, setItems] = usePicked();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const state = useRef(items);
  useEffect(() => { state.current = items; });
  const changeRef = useRef(onChange);
  useEffect(() => { changeRef.current = onChange; });
  useEffect(() => { changeRef.current?.(items.length); }, [items.length]);

  useEffect(() => {
    handleRef.current = {
      hasFiles: () => state.current.length > 0,
      clear: () => { revokePicked(state.current); state.current = []; setItems([]); setProgress(null); },
      upload: async (opts) => {
        const picked = state.current;
        if (!picked.length) return [];
        setProgress({ done: 0, total: picked.length });
        try {
          const album = await systemAlbum('wall');
          const out = await addPhotos(album, picked.map((p) => p.file), picked.map((p) => p.caption),
            (done) => setProgress({ done, total: picked.length }), opts?.audience);
          return out.map(({ row, payload }) => ({ id: row.id, albumId: album.id, files: payload.files, ...(payload.caption ? { caption: payload.caption } : {}) }));
        } finally {
          setProgress(null);
        }
      },
    };
    return () => { handleRef.current = null; };
  }, [handleRef, setItems]);

  return (
    <div className="kp-attach">
      <PhotoPicker items={items} onItems={setItems} max={MAX_ATTACH} compact disabled={!!progress} progress={progress} />
    </div>
  );
}
