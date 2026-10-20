'use client';
import { useMemo, useState, type InputHTMLAttributes } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '@/lib/auth/password';
import { TextField } from '@/components/ui/Field';
import { IconButton } from '@/components/ui/Button';

const STRENGTH: MessageKey[] = ['strength.0', 'strength.1', 'strength.2', 'strength.3', 'strength.4'];

export interface PassphraseFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'prefix'> {
  label: string;
  value: string;
  onValue: (v: string) => void;
  /** Show the strength meter (new passphrases). */
  meter?: boolean;
  /** Words to penalise (name, handle). */
  userInputs?: string[];
  error?: string | null;
  hint?: string;
}

/** Password/passphrase input with show/hide and (optionally) an on-device strength meter (zxcvbn). */
export function PassphraseField({ label, value, onValue, meter, userInputs, error, hint, ...rest }: PassphraseFieldProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const s = useMemo(() => (meter && value ? passwordStrength(value, userInputs) : null), [meter, value, userInputs]);
  const meterHint = s
    ? (value.length < MIN_PASSWORD_LENGTH ? t('passphrase.tooShort', { min: MIN_PASSWORD_LENGTH })
      : !s.ok ? t('passphrase.addWords') : t('passphrase.good'))
    : hint;
  return (
    <div className="k-stack-sm">
      <TextField
        label={label}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        error={error ?? undefined}
        hint={meterHint}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        suffix={<IconButton icon={shown ? 'eyeOff' : 'eye'} size="sm" label={shown ? t('passphrase.hide') : t('passphrase.show')} onClick={() => setShown((x) => !x)} />}
        {...rest}
      />
      {meter ? (
        <div className="k-row" aria-live="polite">
          <div className="k-meter" data-score={s ? s.score : 0} data-ok={s?.ok ? '' : undefined} aria-hidden style={{ flex: 1 }}>
            <span /><span /><span /><span />
          </div>
          <span className="k-small k-muted" style={{ minInlineSize: '6em', textAlign: 'end' }}>{s ? t(STRENGTH[s.score]!) : ''}</span>
        </div>
      ) : null}
    </div>
  );
}

export function passphraseOk(value: string, userInputs: string[] = []): boolean {
  return passwordStrength(value, userInputs).ok;
}
