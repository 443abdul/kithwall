'use client';
import { useId, type ReactNode } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/** On/off switch (role="switch"). Space/Enter toggle it; the whole row is clickable. */
export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="k-switch-row">
      <span className="k-switch-text">
        <label htmlFor={id} className="k-label">{label}</label>
        {description ? <span className="k-hint" id={`${id}-d`}>{description}</span> : null}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        className="k-switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
