'use client';
// Shows a new 24-word recovery key, then asks for three of the words back before it counts as saved.
import { useMemo, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';

export function RecoveryPhrase({ phrase, onDone, busy }: { phrase: string; onDone: () => void; busy?: boolean }) {
  const t = useT();
  const words = useMemo(() => phrase.split(' '), [phrase]);
  const checks = useMemo(() => {
    const idx = new Set<number>();
    const r = new Uint32Array(8);
    while (idx.size < 3) { crypto.getRandomValues(r); for (const v of r) if (idx.size < 3) idx.add(v % words.length); }
    return [...idx].sort((a, b) => a - b);
  }, [words.length]);
  const [step, setStep] = useState<'show' | 'check'>('show');
  const [wrong, setWrong] = useState(false);

  function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = checks.every((i) => String(f.get(`w${i}`) ?? '').trim().toLowerCase() === words[i]);
    setWrong(!ok);
    if (ok) onDone();
  }

  if (step === 'check') {
    return (
      <form className="k-stack" onSubmit={confirm}>
        <p>{t('settings.recovery.checkBody')}</p>
        {wrong ? <Callout tone="danger">{t('settings.recovery.checkWrong')}</Callout> : null}
        {checks.map((i) => (
          <TextField key={i} name={`w${i}`} label={t('settings.recovery.word', { n: i + 1 })} autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" />
        ))}
        <div className="k-row-wrap">
          <Button type="submit" variant="primary" busy={busy}>{t('settings.recovery.confirm')}</Button>
          <Button variant="ghost" onClick={() => setStep('show')}>{t('settings.recovery.showAgain')}</Button>
        </div>
      </form>
    );
  }
  return (
    <div className="k-stack">
      <Callout tone="warning">{t('settings.recovery.writeDown')}</Callout>
      <ol className="k-set-words" translate="no">{words.map((w, i) => <li key={i}>{w}</li>)}</ol>
      <div><Button variant="primary" onClick={() => setStep('check')}>{t('settings.recovery.written')}</Button></div>
    </div>
  );
}
