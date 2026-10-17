'use client';
// Shows a new 24-word recovery key and asks for three of the words back before finishing.
import { useMemo, useState, type FormEvent } from 'react';
import '@/styles/auth.css';

export function PhraseDisplay({ phrase, onDone, doneLabel = 'Done' }: { phrase: string; onDone: () => void; doneLabel?: string }) {
  const words = useMemo(() => phrase.split(' '), [phrase]);
  const checks = useMemo(() => {
    const idx = new Set<number>();
    const r = new Uint32Array(8);
    while (idx.size < 3) { crypto.getRandomValues(r); for (const v of r) { if (idx.size < 3) idx.add(v % words.length); } }
    return [...idx].sort((a, b) => a - b);
  }, [words.length]);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function onConfirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!checks.every((i) => String(f.get(`w${i}`) ?? '').trim().toLowerCase() === words[i])) {
      setErr('Those words don\'t match your recovery key. Check what you wrote down.');
      return;
    }
    setErr(null);
    onDone();
  }

  if (confirming) {
    return (
      <form className="form" onSubmit={onConfirm}>
        {err && <div className="err" role="alert">{err}</div>}
        <p style={{ marginBottom: 8 }}>Let&rsquo;s make sure you wrote it down correctly.</p>
        <table><tbody>
          {checks.map((i) => (
            <tr key={i}><td className="l"><label htmlFor={`pw${i}`}>Word #{i + 1}:</label></td>
              <td><input id={`pw${i}`} name={`w${i}`} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} /></td></tr>
          ))}
          <tr><td /><td><button className="btn b">{doneLabel}</button> <button type="button" className="kw-link" onClick={() => setConfirming(false)}>Show the words again</button></td></tr>
        </tbody></table>
      </form>
    );
  }
  return (
    <div>
      <div className="note" style={{ lineHeight: '16px' }}>
        <b>This is your new recovery key.</b> Write these 24 words on paper and keep them somewhere safe. Your old recovery key no longer works.
        Kithwall can&rsquo;t show them to you again.
      </div>
      <ol className="kw-phrase">{words.map((w, i) => <li key={i}>{w}</li>)}</ol>
      <button type="button" className="btn b" onClick={() => setConfirming(true)}>I&rsquo;ve Written It Down</button>
    </div>
  );
}
