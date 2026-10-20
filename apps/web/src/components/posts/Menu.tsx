'use client';
// A small overflow menu ("⋯"): menu button + popover list (WAI-ARIA menu pattern). Esc / outside click
// close it and return focus to the button; arrow keys move between items.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';

export interface MenuItem { label: string; icon?: IconName; onSelect: () => void; danger?: boolean }

export function Menu({ label, items, icon = 'more' }: { label: string; items: MenuItem[]; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  function close(focus = true) { setOpen(false); if (focus) btn.current?.focus(); }

  function onKey(e: KeyboardEvent<HTMLUListElement>) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  }

  if (!items.length) return null;
  return (
    <div className="k-menu">
      <button ref={btn} type="button" className="k-iconbtn k-iconbtn-sm" aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <Icon name={icon} />
      </button>
      {open ? (
        <ul ref={list} id={id} role="menu" aria-label={label} className="k-menu-list" onKeyDown={onKey}>
          {items.map((it) => (
            <li key={it.label} role="none">
              <button type="button" role="menuitem" className="k-menu-item" data-danger={it.danger ? '' : undefined}
                onClick={() => { close(false); it.onSelect(); }}>
                {it.icon ? <Icon name={it.icon} /> : null}<span>{it.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
