'use client';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Badge } from './Badge';

export interface TabItem<T extends string> { value: T; label: ReactNode; count?: number; panel: ReactNode }

export interface TabsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  label: string;
}

/** WAI-ARIA tabs with automatic activation; arrow keys follow the reading direction. */
export function Tabs<T extends string>({ value, onChange, items, label }: TabsProps<T>) {
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = items.findIndex((x) => x.value === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let n = -1;
    if (e.key === fwd) n = (i + 1) % items.length;
    else if (e.key === back) n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(items[n]!.value);
    refs.current[n]?.focus();
  }
  const active = items.find((x) => x.value === value) ?? items[0];
  return (
    <div className="k-tabs">
      <div role="tablist" aria-label={label} className="k-tablist" onKeyDown={onKey}>
        {items.map((it, i) => (
          <button
            key={it.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={`${base}-t-${it.value}`}
            aria-selected={it.value === value}
            aria-controls={`${base}-p-${it.value}`}
            tabIndex={it.value === value ? 0 : -1}
            className="k-tab"
            onClick={() => onChange(it.value)}
          >
            {it.label}{it.count ? <> <Badge tone="soft" count={it.count} /></> : null}
          </button>
        ))}
      </div>
      {active ? (
        <div role="tabpanel" id={`${base}-p-${active.value}`} aria-labelledby={`${base}-t-${active.value}`} tabIndex={0}>
          {active.panel}
        </div>
      ) : null}
    </div>
  );
}
