'use client';
// Name, emoji, colour and description of a circle (create and settings). Everything here is sealed
// to the circle's members before it leaves the device.
import { useT } from '@/i18n';
import { TextField, Textarea } from '@/components/ui/Field';
import { cx } from '@/components/ui/cx';
import { CIRCLE_EMOJI, CIRCLE_TONES, firstGrapheme, type CircleTone } from './look';
import type { MessageKey } from '@/i18n';

export interface CircleDraft { name: string; description: string; emoji: string; tone: CircleTone }

const TONE_LABEL: Record<CircleTone, MessageKey> = {
  accent: 'circles.tone.accent', accent2: 'circles.tone.accent2', success: 'circles.tone.success',
  warning: 'circles.tone.warning', danger: 'circles.tone.danger', neutral: 'circles.tone.neutral',
};

export function CircleForm({ value, onChange, nameError }: { value: CircleDraft; onChange: (v: CircleDraft) => void; nameError?: string }) {
  const t = useT();
  const set = (patch: Partial<CircleDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="k-stack">
      <div className="kc-preview" data-tone={value.tone} aria-hidden>
        <span className="kc-mark kc-mark-lg" data-tone={value.tone}>{value.emoji || firstGrapheme(value.name).toUpperCase() || '•'}</span>
        <span dir="auto" className="kc-preview-name">{value.name || t('circles.form.namePh')}</span>
      </div>
      <TextField label={t('circles.form.name')} value={value.name} maxLength={80} required
        placeholder={t('circles.form.namePh')} error={nameError} autoComplete="off"
        onChange={(e) => set({ name: e.target.value })} />

      <fieldset className="kc-fieldset">
        <legend className="k-label">{t('circles.form.emoji')}</legend>
        <div className="kc-emoji-grid" role="radiogroup" aria-label={t('circles.form.emoji')}>
          {CIRCLE_EMOJI.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={value.emoji === e} className="kc-emoji"
              onClick={() => set({ emoji: value.emoji === e ? '' : e })}>{e}</button>
          ))}
          <input className="kc-emoji kc-emoji-input" aria-label={t('circles.form.emojiOther')} placeholder="…"
            value={CIRCLE_EMOJI.includes(value.emoji) ? '' : value.emoji}
            onChange={(e) => set({ emoji: firstGrapheme(e.target.value) })} />
        </div>
      </fieldset>

      <fieldset className="kc-fieldset">
        <legend className="k-label">{t('circles.form.colour')}</legend>
        <div className="kc-tones" role="radiogroup" aria-label={t('circles.form.colour')}>
          {CIRCLE_TONES.map((tone) => (
            <button key={tone} type="button" role="radio" aria-checked={value.tone === tone}
              className={cx('kc-tone')} data-tone={tone} aria-label={t(TONE_LABEL[tone])} title={t(TONE_LABEL[tone])}
              onClick={() => set({ tone })} />
          ))}
        </div>
      </fieldset>

      <Textarea label={t('circles.form.description')} value={value.description} maxLength={1000} rows={3}
        placeholder={t('circles.form.descriptionPh')} onChange={(e) => set({ description: e.target.value })} />
    </div>
  );
}
