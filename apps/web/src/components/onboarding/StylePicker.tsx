'use client';
// Style (warm / minimal / bold) + mode (system / light / dark) picker with live mini previews. Each preview
// re-declares the palette locally (.k-theme[data-style][data-mode], styles/v2/tokens.css), so all three
// styles render side by side; picking one applies it to the whole app immediately.
import { useRef, type KeyboardEvent } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { STYLES, setMode, setStyle, usePrefs, type Mode, type ModePref, type StylePref } from '@/lib/theme';
import { Segmented } from '@/components/ui/Segmented';
import { Icon } from '@/components/ui/Icon';
import { LogoMark } from '@/components/shell/Logo';

const NAME: Record<StylePref, MessageKey> = { warm: 'style.warm', minimal: 'style.minimal', bold: 'style.bold' };
const DESC: Record<StylePref, MessageKey> = { warm: 'style.warmDesc', minimal: 'style.minimalDesc', bold: 'style.boldDesc' };

/** A miniature Kithwall screen drawn in the given style and mode. Decorative. */
export function StylePreview({ style, mode }: { style: StylePref; mode: Mode }) {
  const t = useT();
  return (
    <div className="k-theme k-preview" data-style={style} data-mode={mode} aria-hidden>
      <div className="k-preview-bar">
        <LogoMark size={16} />
        <span className="k-preview-dots"><i /><i /></span>
      </div>
      <div className="k-preview-stories"><i /><i /><i /><i /></div>
      <div className="k-preview-card">
        <div className="k-preview-row">
          <span className="k-preview-av">{t('preview.initial')}</span>
          <span className="k-preview-name">{t('preview.name')}</span>
        </div>
        <p className="k-preview-text">{t('preview.post')}</p>
        <div className="k-preview-row">
          <span className="k-preview-btn">{t('preview.reply')}</span>
          <span className="k-preview-chip"><Icon name="heart" /></span>
        </div>
      </div>
      <div className="k-preview-tabs"><i data-on="" /><i /><i /><i /><i /></div>
    </div>
  );
}

export function StylePicker({ headingId }: { headingId?: string }) {
  const t = useT();
  const prefs = usePrefs();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = STYLES.indexOf(prefs.style);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let n = -1;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || e.key === 'ArrowDown') n = (i + 1) % STYLES.length;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || e.key === 'ArrowUp') n = (i - 1 + STYLES.length) % STYLES.length;
    if (n < 0) return;
    e.preventDefault();
    setStyle(STYLES[n]!);
    refs.current[n]?.focus();
  }

  return (
    <div className="k-stylepicker">
      <div role="radiogroup" aria-labelledby={headingId} aria-label={headingId ? undefined : t('style.label')} className="k-style-grid" onKeyDown={onKey}>
        {STYLES.map((s, i) => {
          const on = prefs.style === s;
          return (
            <button
              key={s}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className="k-style-card"
              onClick={() => setStyle(s)}
            >
              <StylePreview style={s} mode={prefs.resolved} />
              <span className="k-style-meta">
                <span className="k-style-name">{t(NAME[s])}{on ? <Icon name="check" /> : null}</span>
                <span className="k-style-desc">{t(DESC[s])}</span>
              </span>
            </button>
          );
        })}
      </div>
      <Segmented<ModePref>
        label={t('mode.label')}
        block
        value={prefs.mode}
        onChange={setMode}
        options={[
          { value: 'system', label: t('mode.system'), icon: 'monitor' },
          { value: 'light', label: t('mode.light'), icon: 'sun' },
          { value: 'dark', label: t('mode.dark'), icon: 'moon' },
        ]}
      />
    </div>
  );
}
