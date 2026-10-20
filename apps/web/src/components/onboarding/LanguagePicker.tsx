'use client';
import { useId } from 'react';
import { LOCALES, LOCALE_NAMES, setLocale, useLocale, useT, isLocale } from '@/i18n';
import { Icon } from '@/components/ui/Icon';

/** Native <select> of languages (each named in its own script). "Automatic" follows the device. */
export function LanguagePicker({ compact, label }: { compact?: boolean; label?: string }) {
  const t = useT();
  const id = useId();
  const { pref, locale } = useLocale();
  return (
    <div className={compact ? 'k-lang k-lang-compact' : 'k-field k-lang'}>
      <label htmlFor={id} className={compact ? 'k-sr-only' : 'k-label'}>{label ?? t('settings.language')}</label>
      <div className={compact ? 'k-lang-pill' : 'k-control'}>
        <Icon name="globe" />
        <select
          id={id}
          className="k-input"
          value={pref ?? 'auto'}
          onChange={(e) => { const v = e.target.value; void setLocale(isLocale(v) ? v : null); }}
        >
          <option value="auto">{compact ? LOCALE_NAMES[locale].native : t('settings.languageAuto')}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>{LOCALE_NAMES[l].native}{l !== 'en' ? ` — ${LOCALE_NAMES[l].english}` : ''}</option>
          ))}
        </select>
        <Icon name="down" />
      </div>
    </div>
  );
}
