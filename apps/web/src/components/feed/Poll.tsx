'use client';
// Question poll (reference pollHTML): result bars, click to vote / change / remove your vote,
// "Add an option..." when the asker allowed it. Votes are encrypted (lib/social/polls.ts) and
// tallied on this device.
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '@/components/Avatar';
import { castVote, fetchVotes, removeVote, tally } from '@/lib/social/polls';
import { notifySafe, snippet } from '@/lib/feed/feed';
import { people, usePeopleVersion } from '@/lib/people';
import { useSession } from '@/lib/keys/session';
import { plural } from '@/lib/format';
import type { PostPayload, PostRow } from '@/lib/types';

export function Poll({ row, question, contentKey }: { row: PostRow; question: NonNullable<PostPayload['question']>; contentKey: Uint8Array | null }) {
  usePeopleVersion();
  const { userId } = useSession();
  const qc = useQueryClient();
  const key = ['votes', row.id];
  const votes = useQuery({ queryKey: key, queryFn: () => fetchVotes(row.id, contentKey) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opt, setOpt] = useState('');
  const options = tally(question.options ?? [], !!question.allowAdd, votes.data ?? []);
  const max = Math.max(1, ...options.map((o) => o.voters.length));
  const total = (votes.data ?? []).length;
  const mine = (votes.data ?? []).find((v) => v.voter === userId)?.choice?.toLowerCase();

  const vote = async (choice: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      if (mine === choice.trim().toLowerCase()) await removeVote(row.id);
      else {
        await castVote(row.id, contentKey, choice);
        if (!mine) await notifySafe(row.author_id, 'question_vote', 'post', row.id, snippet(choice, 60));
      }
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const t = opt.trim();
    if (!t) return;
    setOpt('');
    void vote(t);
  };

  return (
    <div className="kw-poll">
      {err && <div className="err" role="alert">{err}</div>}
      {options.map((o) => {
        const isMine = mine === o.text.toLowerCase();
        return (
          <div className="opt" key={o.text}>
            <button type="button" className={`bx${isMine ? ' mine' : ''}`} disabled={busy} aria-pressed={isMine}
              title={isMine ? 'Click to remove your vote' : 'Click to vote'} onClick={() => void vote(o.text)}>
              <i className="f" style={{ width: `${Math.round((o.voters.length / max) * 100)}%` }} />
              <span>{isMine ? '✓ ' : ''}{o.text}</span>
            </button>
            <span className="cnt">{o.voters.length}</span>
            <span className="vs">{o.voters.slice(0, 3).map((v) => <span key={v} title={people.person(v)?.name ?? ''}><Avatar id={v} size={18} /></span>)}</span>
          </div>
        );
      })}
      {question.allowAdd && (
        <form onSubmit={add} style={{ marginTop: 4 }}>
          <input type="text" placeholder="Add an option..." aria-label="Add an option" maxLength={80} value={opt} onChange={(e) => setOpt(e.target.value)} className="kw-addopt" />
        </form>
      )}
      <div className="gray" style={{ marginTop: 3 }}>
        {votes.isLoading ? 'Loading answers…' : <>{plural(total, 'vote')} &middot; {plural(new Set((votes.data ?? []).map((v) => v.voter)).size, 'person', 'people')} answered</>}
      </div>
    </div>
  );
}
