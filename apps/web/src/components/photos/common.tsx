'use client';
// Shared building blocks for the photos area: lazy decrypted images, decrypt hooks, dialogs.
import '@/styles/photos.css';
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { fileUrl } from '@/lib/media';
import { useSession } from '@/lib/keys/session';
import { keyring } from '@/lib/keys/keyring';
import { useKeyringVersion } from '@/lib/hooks';
import { usePeopleVersion, usePerson } from '@/lib/people';
import { readAlbum, readPhoto, type AlbumRow, type PhotoRow } from '@/lib/photos';
import type { FileRef } from '@/lib/types';

/** True once the element has scrolled near the viewport (stays true). */
export function useInView<T extends Element>(rootMargin = '300px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    // Already on screen at mount: don't wait for the first observer callback (it is only
    // delivered after a rendered frame, which background tabs may not produce).
    const r = el.getBoundingClientRect();
    const margin = parseInt(rootMargin, 10) || 0;
    if (r.bottom >= -margin && r.top <= window.innerHeight + margin && r.right >= -margin && r.left <= window.innerWidth + margin) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen];
}

/** Decrypted object URL for a file, fetched only when `enabled`. */
export function useLazyFileUrl(file: FileRef | null | undefined, enabled: boolean): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ path: string | null; url: string | null; failed: boolean }>({ path: null, url: null, failed: false });
  const path = file?.path ?? null;
  useEffect(() => {
    if (!file || !enabled) return;
    let live = true;
    fileUrl(file).then((url) => { if (live) setState({ path: file.path, url, failed: false }); })
      .catch(() => { if (live) setState({ path: file.path, url: null, failed: true }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled]);
  if (!path || state.path !== path) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** A decrypted image that only downloads when scrolled into view. Sized by its container/CSS. */
export function LazyImg({ file, alt, className = '', style, eager = false }:
  { file: FileRef | null | undefined; alt: string; className?: string; style?: React.CSSProperties; eager?: boolean }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const { url, failed } = useLazyFileUrl(file, eager || seen);
  return (
    <span ref={ref} className={`kp-img ${url ? '' : failed || !file ? 'fail' : 'ld'} ${className}`} style={style}
      role={url ? undefined : 'img'} aria-label={url ? undefined : alt || 'Photo'} aria-busy={!url && !failed && !!file}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url ? <img src={url} alt={alt} draggable={false} /> : null}
    </span>
  );
}

/** Re-render when keys or people change, and report whether keys are loaded. */
export function useKeysReady(): boolean {
  const { status } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  return status === 'ready' && !!keyring.friendsAudience;
}

export function usePhotoPayload(row: PhotoRow | null | undefined) {
  const kv = useKeyringVersion();
  const pv = usePeopleVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (row ? readPhoto(row) : null), [row, kv, pv]);
}

export function useAlbumPayload(row: AlbumRow | null | undefined) {
  const kv = useKeyringVersion();
  const pv = usePeopleVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (row ? readAlbum(row) : null), [row, kv, pv]);
}

/** "Waiting for X's device…" / "couldn't be verified" (dev-guide rule 5). */
export function Undecryptable({ reason, ownerId }: { reason: 'waiting' | 'unverified'; ownerId: string }) {
  const p = usePerson(ownerId);
  if (reason === 'unverified') return <div className="kp-wait">This item couldn&rsquo;t be verified.</div>;
  return <div className="kp-wait">Waiting for {p?.name ?? 'the owner'}&rsquo;s device to share this with you.</div>;
}

/** 2010 dialog with a focus trap; Escape and the overlay close it. */
export function Dialog({ title, onClose, children, buttons, wide = false, busy = false }:
  { title: string; onClose: () => void; children: ReactNode; buttons?: ReactNode; wide?: boolean; busy?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = box.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),textarea,select,canvas[tabindex],[tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    (focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!busyRef.current) { e.stopPropagation(); closeRef.current(); } return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  const id = useMemo(() => `kpd-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div className="ov" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dlg kp-dlg" role="dialog" aria-modal="true" aria-labelledby={id} ref={box} tabIndex={-1}
        style={wide ? { width: 560, maxWidth: 'calc(100vw - 16px)' } : undefined}>
        <h4 id={id}>{title}</h4>
        <div className="c">{children}</div>
        {buttons ? <div className="b">{buttons}</div> : null}
      </div>
    </div>
  );
}

/** Simple confirm dialog. */
export function Confirm({ title, body, action, onConfirm, onClose }:
  { title: string; body: ReactNode; action: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog title={title} onClose={onClose} busy={busy} buttons={<>
      <button className="btn b" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await onConfirm(); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
      }}>{busy ? 'Working…' : action}</button>
      <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
    </>}>
      {body}
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
    </Dialog>
  );
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
