'use client';
// Composer options (phase 3): a disappearing-post timer (off / 1 day / 1 week / 1 month) and a publish time
// for scheduled posts, picked in the user's own time zone. The post is still sealed on this device at once;
// the server only shows it to its audience from the chosen time and deletes it when its timer runs out.
// Also who can comment on this one post (docs/v2/10-follow-public.md §6): the database enforces it.
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button, IconButton } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import {
  checkSchedule, defaultScheduleTime, durationKey, fromLocalInput, MAX_SCHEDULE_MS, MIN_SCHEDULE_MS, POST_TIMERS,
  toLocalInput, type PostTimer, type ScheduleProblem,
} from '@/lib/chat/ephemeral';
import type { CommentPolicy } from '@/lib/types';
import type { MessageKey } from '@/i18n';

/** `comments`: who can comment on this post; null/undefined = my account setting. */
export interface PostOptionsValue { disappear: PostTimer; schedule: Date | null; comments?: CommentPolicy | null }

export const COMMENT_POLICIES: readonly CommentPolicy[] = ['everyone', 'followers', 'connections', 'nobody'];
export const commentPolicyKey = (p: CommentPolicy) => `comments.policy.${p}` as MessageKey;

/** "Who can comment": my account setting, or one of the four choices. */
export function CommentPolicySelect({ value, onChange, label, allowDefault = true, disabled, everyone }: {
  value: CommentPolicy | null; onChange: (v: CommentPolicy | null) => void; label: string; allowDefault?: boolean; disabled?: boolean;
  /** Wording of the widest choice when the question isn't about a post ("Who can mention me": Everyone). */
  everyone?: string;
}) {
  const t = useT();
  return (
    <label className="k-stack-sm">
      <span className="k-label">{label}</span>
      <select className="k-control" value={value ?? ''} disabled={disabled}
        onChange={(e) => onChange(e.target.value ? (e.target.value as CommentPolicy) : null)}>
        {allowDefault ? <option value="">{t('comments.policy.default')}</option> : null}
        {COMMENT_POLICIES.map((p) => <option key={p} value={p}>{p === 'everyone' && everyone ? everyone : t(commentPolicyKey(p))}</option>)}
      </select>
    </label>
  );
}

/** "Tue 24 Oct, 17:30" in the user's language and time zone. */
export function useWhen() {
  const f = useFormat();
  return (d: Date | string) => f.date(typeof d === 'string' ? new Date(d) : d, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function scheduleProblemKey(p: ScheduleProblem) {
  return `schedule.problem.${p}` as const;
}

function timeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

/** Picks a time for a scheduled post (used by the composer and the Scheduled list). */
export function SchedulePicker({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const tz = timeZone();
  return (
    <TextField type="datetime-local" label={t('schedule.when')} value={value} onChange={(e) => onChange(e.target.value)}
      min={toLocalInput(new Date(now + MIN_SCHEDULE_MS))} max={toLocalInput(new Date(now + MAX_SCHEDULE_MS))}
      error={error ?? undefined} hint={tz ? t('schedule.tz', { tz }) : undefined} />
  );
}

export function PostOptionsDialog({ open, value, onClose, onChange }: {
  open: boolean; value: PostOptionsValue; onClose: () => void; onChange: (v: PostOptionsValue) => void;
}) {
  const t = useT();
  const [later, setLater] = useState(!!value.schedule);
  const [when, setWhen] = useState(() => toLocalInput(value.schedule ?? defaultScheduleTime()));
  const [problem, setProblem] = useState<ScheduleProblem | null>(null);
  const [disappear, setDisappear] = useState<PostTimer>(value.disappear);
  const [comments, setComments] = useState<CommentPolicy | null>(value.comments ?? null);
  // Re-sync each time the sheet opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLater(!!value.schedule); setWhen(toLocalInput(value.schedule ?? defaultScheduleTime()));
      setDisappear(value.disappear); setProblem(null); setComments(value.comments ?? null);
    }
  }

  function done() {
    if (later) {
      const d = fromLocalInput(when);
      const p = checkSchedule(d);
      if (p) { setProblem(p); return; }
      onChange({ disappear, schedule: d, comments });
    } else {
      onChange({ disappear, schedule: null, comments });
    }
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('schedule.options')} sheet
      footer={<><Button variant="ghost" onClick={onClose}>{t('feed.cancel')}</Button><Button variant="primary" onClick={done}>{t('common.done')}</Button></>}>
      <div className="k-stack">
        <section className="k-stack-sm" aria-labelledby="k-po-dis">
          <h3 id="k-po-dis" className="k-eph-h"><Icon name="clock" /> {t('ephemeral.post.label')}</h3>
          <p className="k-small k-muted">{t('ephemeral.post.sub')}</p>
          <Segmented block label={t('ephemeral.post.label')} value={String(disappear ?? 'off')}
            onChange={(v) => setDisappear(v === 'off' ? null : (Number(v) as PostTimer))}
            options={POST_TIMERS.map((v) => ({ value: String(v ?? 'off'), label: t(durationKey(v)) }))} />
        </section>
        <section className="k-stack-sm" aria-labelledby="k-po-sch">
          <h3 id="k-po-sch" className="k-eph-h"><Icon name="calendar" /> {t('schedule.label')}</h3>
          <Segmented block label={t('schedule.label')} value={later ? 'later' : 'now'}
            onChange={(v) => { setLater(v === 'later'); setProblem(null); }}
            options={[{ value: 'now', label: t('schedule.now') }, { value: 'later', label: t('schedule.later') }]} />
          {later ? (
            <>
              <SchedulePicker value={when} onChange={(v) => { setWhen(v); setProblem(null); }} error={problem ? t(scheduleProblemKey(problem)) : null} />
              <p className="k-small k-muted"><Icon name="lock" /> {t('schedule.note')}</p>
            </>
          ) : null}
        </section>
        <section className="k-stack-sm" aria-labelledby="k-po-com">
          <h3 id="k-po-com" className="k-eph-h"><Icon name="comment" /> {t('comments.policy.title')}</h3>
          <CommentPolicySelect label={t('comments.policy.thisPost')} value={comments} onChange={setComments} />
        </section>
      </div>
    </Dialog>
  );
}

/** Chips under the composer text showing the chosen options, each removable. */
export function PostOptionChips({ value, disabled, onChange, onOpen }: {
  value: PostOptionsValue; disabled?: boolean; onChange: (v: PostOptionsValue) => void; onOpen: () => void;
}) {
  const t = useT();
  const when = useWhen();
  if (!value.disappear && !value.schedule && !value.comments) return null;
  return (
    <ul className="k-eph-chips" role="list">
      {value.comments ? (
        <li className="k-eph-chip">
          <button type="button" className="k-eph-chip-main" onClick={onOpen} disabled={disabled}>
            <Icon name="comment" /><span>{t('comments.policy.chip', { who: t(commentPolicyKey(value.comments)) })}</span>
          </button>
          <IconButton icon="close" size="sm" label={t('comments.policy.default')} disabled={disabled} onClick={() => onChange({ ...value, comments: null })} />
        </li>
      ) : null}
      {value.schedule ? (
        <li className="k-eph-chip">
          <button type="button" className="k-eph-chip-main" onClick={onOpen} disabled={disabled}>
            <Icon name="calendar" /><span>{t('schedule.chip', { when: when(value.schedule) })}</span>
          </button>
          <IconButton icon="close" size="sm" label={t('schedule.publishNow')} disabled={disabled} onClick={() => onChange({ ...value, schedule: null })} />
        </li>
      ) : null}
      {value.disappear ? (
        <li className="k-eph-chip">
          <button type="button" className="k-eph-chip-main" onClick={onOpen} disabled={disabled}>
            <Icon name="clock" /><span>{t('ephemeral.post.chip', { duration: t(durationKey(value.disappear)) })}</span>
          </button>
          <IconButton icon="close" size="sm" label={t('ephemeral.post.keep')} disabled={disabled} onClick={() => onChange({ ...value, disappear: null })} />
        </li>
      ) : null}
    </ul>
  );
}
