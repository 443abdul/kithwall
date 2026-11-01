'use client';
// Settings → Translation (lib/translate): "Offer translation" for this device and, in the Android app, the
// language packs downloaded to this phone with a Remove button. Hidden where there is no on-device engine.
import { useEffect, useState } from 'react';
import { useFormat, useLocale, useT } from '@/i18n';
import { PACK_BYTES, languageName, setTranslationOffered, translation, useTranslationEngine, useTranslationOffered } from '@/lib/translate';
import { formatBytes } from '@/components/posts/bits';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';

export function TranslationSettings() {
  const t = useT();
  const engine = useTranslationEngine();
  const offered = useTranslationOffered();
  if (!engine || engine === 'none') return null;
  return (
    <section className="k-stack" aria-labelledby="translate-h">
      <h2 id="translate-h" className="k-section-title">{t('translate.settings.title')}</h2>
      <Card>
        <div className="k-stack">
          <Switch checked={offered} onChange={setTranslationOffered} label={t('translate.settings.offer')} description={t('translate.settings.offerHint')} />
          {engine === 'native' ? <Packs /> : <p className="k-muted k-small">{t('translate.settings.browser')}</p>}
        </div>
      </Card>
    </section>
  );
}

function Packs() {
  const t = useT();
  const f = useFormat();
  const { tag } = useLocale();
  const [packs, setPacks] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let live = true;
    void translation.packs().then((p) => { if (live) setPacks(p ?? []); }).catch(() => { if (live) setPacks([]); });
    return () => { live = false; };
  }, []);

  async function remove(lang: string) {
    setRemoving(lang);
    setNote('');
    try {
      await translation.removePack(lang);
      setPacks((p) => (p ?? []).filter((x) => x !== lang));
      setNote(t('translate.settings.removed', { language: languageName(lang, tag) }));
    } catch {
      setNote(t('translate.settings.removeFailed'));
    } finally { setRemoving(null); }
  }

  return (
    <div className="k-stack-sm">
      <h3 className="k-label">{t('translate.settings.packs')}</h3>
      {packs === null ? <Skeleton height={40} /> : packs.length === 0 ? <p className="k-muted k-small">{t('translate.settings.noPacks')}</p> : (
        <ul className="k-tr-packlist">
          {packs.map((p) => (
            <li key={p} className="k-set-row">
              <span>{languageName(p, tag)} <span className="k-muted k-small">{t('translate.settings.packSize', { size: formatBytes(PACK_BYTES, f.number) })}</span></span>
              <Button size="sm" variant="secondary" busy={removing === p} disabled={!!removing}
                aria-label={t('translate.settings.removeLabel', { language: languageName(p, tag) })} onClick={() => void remove(p)}>
                {t('translate.settings.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="k-small k-muted" aria-live="polite">{note}</p>
    </div>
  );
}
