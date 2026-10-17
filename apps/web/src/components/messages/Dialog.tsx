'use client';
// 2010-style dialog for the Messages area: traps focus, closes on Escape / backdrop click.
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Dialog({ title, children, buttons, onClose, busy = false }: {
  title: string; children: ReactNode; buttons: ReactNode; onClose: () => void; busy?: boolean;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { close.current = onClose; busyRef.current = busy; });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('input, textarea, select, button.b, button');
    (first ?? box.current)?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!busyRef.current) close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])')];
      if (!els.length) return;
      const a = els[0]!, z = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="ov" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={id} ref={box} tabIndex={-1}>
        <h4 id={id}>{title}</h4>
        <div className="c">{children}</div>
        <div className="b">{buttons}</div>
      </div>
    </div>
  );
}

export function Confirm({ title, children, confirm, onConfirm, onClose }: {
  title: string; children: ReactNode; confirm: string; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const busy = useRef(false);
  const err = useRef<HTMLDivElement>(null);
  const go = async () => {
    if (busy.current) return;
    busy.current = true;
    try { await onConfirm(); onClose(); } catch (e) {
      if (err.current) err.current.textContent = (e as Error).message;
    } finally { busy.current = false; }
  };
  return (
    <Dialog title={title} onClose={onClose}
      buttons={<><button type="button" className="btn b" onClick={() => void go()}>{confirm}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></>}>
      {children}
      <div ref={err} className="kwm-err" role="alert" />
    </Dialog>
  );
}
