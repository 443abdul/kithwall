'use client';
// A post's poll: pick one option (or several), see the results once you have voted (the author always
// can), change or take back your vote. Votes are encrypted to the post's readers (lib/social/engage).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { useSession } from '@/lib/keys/session';
import { castVote, fetchVotes, POLL_MAX_OPTIONS, tally, withdrawVote } from '@/lib/social/engage';
import type { PostPayload, PostRow } from '@/lib/types';

type Poll = NonNullable<PostPayload['poll']>;

export function PollView({ row, poll }: { row: PostRow; poll: Poll }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const { userId } = useSession();
  const n = poll.options.length;
  const key = ['poll', row.id];
  const q = useQuery({ queryKey: key, queryFn: () => fetchVotes(row, n), staleTime: 15_000 });
  const mine = q.data?.find((v) => v.voter === userId)?.choices ?? null;
  const ended = !!poll.ends && Date.parse(poll.ends) <= Date.now();
  const [picked, setPicked] = useState<number[]>([]);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const showResults = ended || row.author_id === userId || (mine !== null && !changing);
  const { counts, voters } = tally(q.data ?? [], n);

  async function submit(choices: number[]) {
    if (!choices.length) return;
    setBusy(true);
    try { await castVote(row, choices); setChanging(false); setPicked([]); await qc.invalidateQueries({ queryKey: key }); }
    catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true);
    try { await withdrawVote(row); await qc.invalidateQueries({ queryKey: key }); }
    catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(false); }
  }

  return (
    <div className="k-poll" role="group" aria-label={poll.question || t('poll.label')}>
      {poll.question ? <p className="k-poll-q" dir="auto">{poll.question}</p> : null}
      {showResults ? (
        <ul className="k-poll-results" role="list">
          {poll.options.map((o, i) => {
            const pct = voters ? Math.round((counts[i]! / voters) * 100) : 0;
            return (
              <li key={i} className="k-poll-bar" data-mine={mine?.includes(i) ? '' : undefined}>
                <span className="k-poll-fill" style={{ inlineSize: `${pct}%` }} aria-hidden />
                <span className="k-poll-opt" dir="auto">{mine?.includes(i) ? <Icon name="check" /> : null}{o}</span>
                <span className="k-poll-pct k-ltr">{f.number(pct / 100, { style: 'percent' })}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="k-poll-options" role="list">
          {poll.options.map((o, i) => {
            const on = picked.includes(i);
            return (
              <li key={i}>
                <button type="button" className="k-poll-choice" aria-pressed={on} disabled={busy || ended}
                  onClick={() => (poll.multi ? setPicked(on ? picked.filter((x) => x !== i) : [...picked, i]) : void submit([i]))}>
                  <span className="k-poll-mark" aria-hidden>{on ? <Icon name="check" /> : null}</span><span dir="auto">{o}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="k-small k-muted k-poll-foot">
        <span>{t('poll.votes', { count: voters })}</span>
        {poll.multi ? <span> · {t('poll.multi')}</span> : null}
        {ended ? <span> · {t('poll.ended')}</span> : null}
        <span> · <Icon name="lock" /> {t('poll.private')}</span>
      </p>
      {!showResults && poll.multi ? (
        <Button size="sm" variant="primary" busy={busy} disabled={!picked.length} onClick={() => void submit(picked)}>{t('poll.vote')}</Button>
      ) : null}
      {mine && !ended && !changing ? (
        <div className="k-row-wrap">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPicked(mine); setChanging(true); }}>{t('poll.change')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void withdraw()}>{t('poll.withdraw')}</Button>
        </div>
      ) : null}
    </div>
  );
}

/** The composer's poll editor (2–6 options). */
export function PollEditor({ value, onChange }: { value: Poll; onChange: (p: Poll | null) => void }) {
  const t = useT();
  const set = (i: number, v: string) => onChange({ ...value, options: value.options.map((o, j) => (j === i ? v : o)) });
  return (
    <div className="k-poll-edit k-stack-sm">
      <TextField label={t('poll.question')} value={value.question ?? ''} maxLength={200} dir="auto" onChange={(e) => onChange({ ...value, question: e.target.value })} />
      {value.options.map((o, i) => (
        <div key={i} className="k-row">
          <TextField label={t('poll.option', { n: i + 1 })} value={o} maxLength={80} dir="auto" onChange={(e) => set(i, e.target.value)} />
          {value.options.length > 2 ? (
            <IconButton size="sm" icon="close" label={t('poll.removeOption', { n: i + 1 })}
              onClick={() => onChange({ ...value, options: value.options.filter((_, j) => j !== i) })} />
          ) : null}
        </div>
      ))}
      <div className="k-row-wrap">
        {value.options.length < POLL_MAX_OPTIONS ? (
          <Button size="sm" variant="soft" icon="plus" onClick={() => onChange({ ...value, options: [...value.options, ''] })}>{t('poll.addOption')}</Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>{t('poll.remove')}</Button>
      </div>
      <Switch checked={!!value.multi} label={t('poll.allowMulti')} onChange={(v) => onChange({ ...value, multi: v || undefined })} />
    </div>
  );
}

/** A poll ready to post, or null if it isn't complete (fewer than two filled-in options). */
export function finishPoll(p: Poll | null): Poll | null {
  if (!p) return null;
  const options = p.options.map((o) => o.trim().slice(0, 80)).filter(Boolean).slice(0, POLL_MAX_OPTIONS);
  if (options.length < 2) return null;
  const question = p.question?.trim().slice(0, 200);
  return { options, ...(question ? { question } : {}), ...(p.multi ? { multi: true } : {}) };
}
