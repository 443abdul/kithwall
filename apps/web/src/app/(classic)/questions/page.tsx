'use client';
// Questions (reference vQuestions): ask with poll options; Friends' Questions · My Questions.
// Answers are encrypted votes, tallied on each reader's device.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { AudienceSelect, toAudience } from '@/components/feed/AudienceSelect';
import { Stream, pageOf } from '@/components/feed/Stream';
import { useAuthors } from '@/components/social/useAuthors';
import { createPost } from '@/lib/content';
import { fetchByKind } from '@/lib/feed/feed';
import { useSession } from '@/lib/keys/session';
import '@/styles/social.css';

function Ask() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '', '']);
  const [allowAdd, setAllowAdd] = useState(true);
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) { setErr('Ask a question first.'); return; }
    setBusy(true); setErr(null);
    const options = [...new Set(opts.map((o) => o.trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
    try {
      await createPost({ kind: 'question', audience: toAudience(aud), payload: { question: { text: text.slice(0, 300), options, allowAdd: allowAdd || !options.length } } });
      setQ(''); setOpts(['', '', '']);
      await qc.invalidateQueries({ queryKey: ['kind', 'question'] });
      await qc.invalidateQueries({ queryKey: ['feed'] });
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="kw-ask" onSubmit={(e) => void submit(e)}>
      {err && <div className="err" role="alert">{err}</div>}
      <input className="q" type="text" placeholder="Ask a question..." aria-label="Question" maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} />
      {opts.map((o, i) => (
        <input key={i} type="text" placeholder="+ Add a poll option" aria-label={`Option ${i + 1}`} maxLength={80} value={o} style={{ marginRight: '1%' }}
          onChange={(e) => { const n = [...opts]; n[i] = e.target.value; if (i === n.length - 1 && e.target.value && n.length < 10) n.push(''); setOpts(n); }} />
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        <label><input type="checkbox" checked={allowAdd} onChange={(e) => setAllowAdd(e.target.checked)} /> Allow friends to add options</label>
        <span style={{ marginLeft: 'auto' }}><AudienceSelect value={aud} onChange={setAud} /></span>
        <button className="btn b" disabled={busy}>{busy ? 'Asking…' : 'Ask Question'}</button>
      </div>
    </form>
  );
}

function Questions() {
  const { userId } = useSession();
  const authors = useAuthors();
  const [mine, setMine] = useState(false);
  const tab = (m: boolean, label: string) => (
    <a role="tab" tabIndex={0} aria-selected={mine === m} className={mine === m ? 'on' : ''} onClick={() => setMine(m)}
      onKeyDown={(e) => { if (e.key === 'Enter') setMine(m); }}>{label}</a>
  );
  return (
    <>
      <Title icon="question">Questions <span className="pill">Beta</span></Title>
      <div className="note">Ask your friends anything. Add poll options to get quick answers. Answers are encrypted: only people who can see your question can see them.</div>
      <Ask />
      <div className="tabs2" role="tablist">{tab(false, 'Friends’ Questions')}{tab(true, 'My Questions')}</div>
      {mine ? <Stream key="mine" queryKey={['kind', 'question', 'user', userId]} load={async (b) => pageOf(await fetchByKind('question', [userId!], b), 20)} empty="You haven't asked any questions yet." />
        : authors ? <Stream key="all" queryKey={['kind', 'question', 'friends']} load={async (b) => pageOf(await fetchByKind('question', authors, b), 20)} empty="No questions yet." />
          : <div className="gray">Loading…</div>}
    </>
  );
}

export default function Page() {
  return <AppPage active="questions" right={<TipsBox />}><Questions /></AppPage>;
}
