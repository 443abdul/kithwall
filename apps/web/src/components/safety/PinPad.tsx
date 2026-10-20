'use client';
// A numeric PIN entry: a masked input (works with any keyboard, incl. screen readers) plus an on-screen
// keypad. The keypad buttons are tabbable but the input keeps focus for typing; Enter submits.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { PIN_MAX } from '@/lib/safety/pin';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export function PinPad({ label, submitLabel, onSubmit, busy, error, disabled, autoFocus = true, id = 'k-pin' }: {
  label: string;
  submitLabel: string;
  /** Called with the PIN; the field is cleared afterwards. */
  onSubmit: (pin: string) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}) {
  const t = useT();
  const [pin, setPin] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const off = !!busy || !!disabled;
  function press(d: string) {
    if (off) return;
    setPin((p) => (p.length >= PIN_MAX ? p : p + d));
    ref.current?.focus({ preventScroll: true });
  }
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (off || !pin) return;
    const v = pin;
    setPin('');
    await onSubmit(v);
    ref.current?.focus({ preventScroll: true });
  }

  return (
    <form className="k-pin" onSubmit={submit} autoComplete="off">
      <label htmlFor={id} className="k-sr-only">{label}</label>
      <div className="k-pin-field" data-invalid={error ? '' : undefined}>
        <input
          ref={ref}
          id={id}
          className="k-pin-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={PIN_MAX}
          value={pin}
          disabled={off}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_MAX))}
        />
        <span className="k-pin-dots" aria-hidden>
          {pin.length ? Array.from({ length: pin.length }, (_, i) => <span key={i} className="k-pin-dot" />) : <span className="k-pin-ph">{label}</span>}
        </span>
      </div>
      {error ? <p className="k-error k-pin-err" id={`${id}-err`} role="alert"><Icon name="alert" />{error}</p> : null}
      <div className="k-pin-keys" dir="ltr">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="k-pin-key" onClick={() => press(d)} disabled={off}>{d}</button>
        ))}
        <button type="button" className="k-pin-key k-pin-key-aux" onClick={() => { setPin((p) => p.slice(0, -1)); ref.current?.focus(); }}
          disabled={off || !pin} aria-label={t('safety.pin.backspace')}>
          <Icon name="back" />
        </button>
        <button type="button" className="k-pin-key" onClick={() => press('0')} disabled={off}>0</button>
        <button type="submit" className="k-pin-key k-pin-key-go" disabled={off || !pin} aria-label={submitLabel}>
          <Icon name="check" />
        </button>
      </div>
      <Button type="submit" variant="primary" size="lg" block busy={busy} disabled={off || !pin}>{submitLabel}</Button>
    </form>
  );
}
