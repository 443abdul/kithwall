'use client';
// 2010 grey-bordered dialog (.ov/.dlg from the reference) with a focus trap and Escape to close.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import '@/styles/auth.css';

export function Dialog({ title, children, buttons, onClose, wide = false }: {
  title: string; children: ReactNode; buttons: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"]),a[role="button"]',
    ) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = root?.querySelector<HTMLElement>('textarea,input,select') ?? focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const a = els[0]!, z = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      else if (!root?.contains(document.activeElement)) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);

  return (
    <div className="ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} style={wide ? { width: 560 } : undefined}>
        <h4 id={titleId}>{title}</h4>
        <div className="c">{children}</div>
        <div className="b">{buttons}</div>
      </div>
    </div>
  );
}
