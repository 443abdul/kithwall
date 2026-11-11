'use client';
// Small hooks shared by the reels screens.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { downloadFile } from '@/lib/media';
import type { FileRef } from '@/lib/types';

const REDUCED = '(prefers-reduced-motion: reduce)';

/** Does the person ask for less motion? (then reels wait for a tap instead of playing by themselves) */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => { const m = window.matchMedia(REDUCED); m.addEventListener('change', l); return () => m.removeEventListener('change', l); },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/**
 * While `open`, the device's Back (Android hardware Back, the browser's back button) closes this layer
 * instead of leaving the screen: an entry is added to the history for as long as it is open, as the photo
 * gallery does. Returns the function every other way of closing must call (the close button, Esc, the
 * backdrop), so the entry is taken off the history again and Back behaves the same either way.
 */
export function useBackCloses(open: boolean, onClose: () => void): () => void {
  const cb = useRef(onClose);
  useEffect(() => { cb.current = onClose; });
  const hist = useRef<{ token: string; pushed: boolean }>({ token: '', pushed: false });
  useEffect(() => {
    if (!open) return;
    const token = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    try {
      history.pushState({ ...((history.state as object | null) ?? {}), kwLayer: token }, '');
      hist.current = { token, pushed: true };
    } catch { hist.current = { token, pushed: false }; /* no history: Back leaves the screen as usual */ }
    const onPop = () => {
      if ((history.state as { kwLayer?: string } | null)?.kwLayer !== token) { hist.current.pushed = false; cb.current(); }
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [open]);
  return () => {
    const h = hist.current;
    if (h.pushed && (history.state as { kwLayer?: string } | null)?.kwLayer === h.token) history.back(); // → popstate → onClose
    else cb.current();
  };
}

export type ReelVideoState =
  | { s: 'idle' }
  | { s: 'loading'; pct: number }
  | { s: 'ready'; url: string }
  | { s: 'error' };

const MIME = /^video\/(mp4|webm|quicktime)$/;

/**
 * A reel's video, fetched and decrypted on this device into an object URL while `want` is true. The URL is
 * released when the reel is no longer wanted (the screen keeps only the one playing and its neighbours).
 * `retry()` tries again after a failure.
 */
export function useReelVideo(file: FileRef | undefined, want: boolean): { state: ReelVideoState; retry: () => void } {
  const [state, setState] = useState<ReelVideoState>({ s: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const path = file?.path;
  useEffect(() => {
    if (!file || !want) return;
    const ac = new AbortController();
    let url: string | null = null;
    let last = -1;
    setState({ s: 'loading', pct: 0 });
    downloadFile(file, {
      signal: ac.signal,
      onProgress: (got, total) => {
        const pct = Math.min(100, Math.floor((got / total) * 100));
        if (pct !== last && !ac.signal.aborted) { last = pct; setState({ s: 'loading', pct }); }
      },
    }).then((plain) => {
      if (ac.signal.aborted) return;
      url = URL.createObjectURL(new Blob([plain as BlobPart], { type: MIME.test(file.mime) ? file.mime : 'video/mp4' }));
      setState({ s: 'ready', url });
    }).catch((e: unknown) => {
      if (!ac.signal.aborted && (e as { name?: string } | null)?.name !== 'AbortError') setState({ s: 'error' });
    });
    return () => {
      ac.abort();
      if (url) URL.revokeObjectURL(url);
      setState({ s: 'idle' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, want, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}
