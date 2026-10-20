'use client';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './cx';

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; icon?: IconName }

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible name of the group. */
  label: string;
  block?: boolean;
  className?: string;
}

/** Single-choice segmented control (radiogroup with roving focus; arrows follow reading direction). */
export function Segmented<T extends string>({ value, onChange, options, label, block, className }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = options.findIndex((o) => o.value === value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + ((e.key === 'ArrowRight' && rtl) ? -1 : 1) + options.length) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i + ((e.key === 'ArrowLeft' && rtl) ? 1 : -1) + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('k-seg', block && 'k-seg-block', className)} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="k-seg-item"
          onClick={() => onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}
