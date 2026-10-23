'use client';
// Download + decrypt an encrypted video (lib/media downloadFile, parts streamed with progress) into an object
// URL that this hook owns: it is revoked, and an unfinished download aborted, when the item changes or the
// viewer closes. `enabled: false` waits (the gallery only fetches a video once the person presses play).
import { useEffect, useState } from 'react';
import { downloadFile } from '@/lib/media';
import type { FileRef } from '@/lib/types';

export function useVideoUrl(ref: FileRef | undefined | null, enabled = true) {
  const [state, setState] = useState<{ url: string | null; progress: number; error: boolean }>({ url: null, progress: 0, error: false });
  const path = ref?.path;
  useEffect(() => {
    if (!ref || !enabled) return;
    const ac = new AbortController();
    let url: string | null = null;
    setState({ url: null, progress: 0, error: false });
    downloadFile(ref, { signal: ac.signal, onProgress: (l, t) => setState((s) => ({ ...s, progress: t ? l / t : 0 })) })
      .then((bytes) => {
        if (ac.signal.aborted) return;
        const mime = /^video\/(mp4|webm|quicktime)$/.test(ref.mime) ? ref.mime : 'video/mp4';
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
        setState({ url, progress: 1, error: false });
      })
      .catch(() => { if (!ac.signal.aborted) setState({ url: null, progress: 0, error: true }); });
    return () => { ac.abort(); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled]);
  return state;
}
