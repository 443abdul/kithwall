'use client';
// 2010-style dialog (grey translucent border, blue title bar). Traps focus, closes on Escape
// and on clicking the backdrop, and restores focus to whatever opened it.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[role="button"]';

export function Dialog({ title, children, buttons, onClose, width }:
  { title: ReactNode; children: ReactNode; buttons?: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const id = useId();
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0]!, z = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="ov" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1} style={width ? { width } : undefined}>
        <h4 id={id}>{title}</h4>
        <div className="c">{children}</div>
        {buttons ? <div className="b">{buttons}</div> : null}
      </div>
    </div>
  );
}

/** Confirm dialog with a primary action that shows progress and errors. */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose }:
  { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(); onClose(); } catch (e) { setErr((e as Error).message || 'Something went wrong.'); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} buttons={<>
      <button type="button" className="btn b" disabled={busy} onClick={() => void go()}>{busy ? 'Working…' : confirmLabel}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
    </>}>
      {err && <div className="err" role="alert">{err}</div>}
      {children}
    </Dialog>
  );
}
