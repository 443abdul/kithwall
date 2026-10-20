'use client';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { Icon } from './Icon';
import { cx } from './cx';

interface FieldChrome {
  label: ReactNode;
  hint?: ReactNode;
  /** Error message; marks the control invalid and is announced. */
  error?: ReactNode;
  /** Visually hide the label (it stays for screen readers). */
  hideLabel?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  className?: string;
}

function Shell({ id, label, hint, error, hideLabel, prefix, suffix, className, area, children }: FieldChrome & {
  id: string; area?: boolean; children: ReactNode;
}) {
  return (
    <div className={cx('k-field', className)}>
      <label htmlFor={id} className={cx('k-label', hideLabel && 'k-sr-only')}>{label}</label>
      <div className={cx('k-control', area && 'k-control-area')} data-invalid={error ? '' : undefined}>
        {prefix ? <span className="k-control-affix">{prefix}</span> : null}
        {children}
        {suffix ? <span className="k-control-affix">{suffix}</span> : null}
      </div>
      {error ? (
        <p className="k-error" id={`${id}-err`} role="alert"><Icon name="alert" />{error}</p>
      ) : hint ? (
        <p className="k-hint" id={`${id}-hint`}>{hint}</p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends FieldChrome, Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'className'> {
  ref?: Ref<HTMLInputElement>;
}

/** Labelled text input with hint / error. */
export function TextField({ label, hint, error, hideLabel, prefix, suffix, className, id: idProp, ref, ...input }: TextFieldProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} hideLabel={hideLabel} prefix={prefix} suffix={suffix} className={className}>
      <input
        ref={ref}
        id={id}
        className="k-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        {...input}
      />
    </Shell>
  );
}

export interface TextareaProps extends FieldChrome, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'prefix' | 'className'> {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ label, hint, error, hideLabel, prefix, suffix, className, id: idProp, ref, ...area }: TextareaProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} hideLabel={hideLabel} prefix={prefix} suffix={suffix} className={className} area>
      <textarea
        ref={ref}
        id={id}
        className="k-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined}
        {...area}
      />
    </Shell>
  );
}
