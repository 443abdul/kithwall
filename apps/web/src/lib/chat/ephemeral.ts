// Disappearing and scheduled content (Kithwall 2 phase 3, migration 20261024000100_ephemeral.sql): the
// timers people can choose, and pure helpers for hiding expired items on this device and for picking a
// publish time in the user's own time zone. No React, no network; unit-tested in ephemeral.test.ts.
//
// The server is the authority: it computes expires_at itself (a client value is ignored), hides expired
// rows with RLS and deletes them within a minute. The helpers here only make the screen agree at once.

/** Chat timers (seconds; null = off). New chats default to 4 weeks (brief §3: protection is the default). */
export const MESSAGE_TIMERS = [null, 86_400, 604_800, 2_419_200, 7_776_000] as const;
export type MessageTimer = (typeof MESSAGE_TIMERS)[number];
export const DEFAULT_MESSAGE_TIMER: MessageTimer = 2_419_200;

/** Post timers (seconds; null = off). Optional, off by default. */
export const POST_TIMERS = [null, 86_400, 604_800, 2_592_000] as const;
export type PostTimer = (typeof POST_TIMERS)[number];

export type DurationKey = 'ephemeral.dur.off' | 'ephemeral.dur.day' | 'ephemeral.dur.week' | 'ephemeral.dur.weeks4'
  | 'ephemeral.dur.month' | 'ephemeral.dur.months3';

/** The i18n key naming a timer ("4 weeks"). Unknown values fall back to the nearest larger label. */
export function durationKey(secs: number | null | undefined): DurationKey {
  if (!secs) return 'ephemeral.dur.off';
  if (secs <= 86_400) return 'ephemeral.dur.day';
  if (secs <= 604_800) return 'ephemeral.dur.week';
  if (secs <= 2_419_200) return 'ephemeral.dur.weeks4';
  if (secs <= 2_592_000) return 'ephemeral.dur.month';
  return 'ephemeral.dur.months3';
}

export const isMessageTimer = (x: unknown): x is MessageTimer => (MESSAGE_TIMERS as readonly unknown[]).includes(x);
export const isPostTimer = (x: unknown): x is PostTimer => (POST_TIMERS as readonly unknown[]).includes(x);

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Has this row's time run out? (rows without expires_at never expire) */
export function isExpired(row: { expires_at?: string | null }, now: number = Date.now()): boolean {
  const t = ms(row.expires_at);
  return Number.isFinite(t) && t <= now;
}

/** Is this post still waiting for its publish time? */
export function isScheduled(row: { publish_at?: string | null }, now: number = Date.now()): boolean {
  const t = ms(row.publish_at);
  return Number.isFinite(t) && t > now;
}

/** The soonest future moment one of these rows expires or goes live (to re-render then), or null. */
export function nextChange(rows: { expires_at?: string | null; publish_at?: string | null }[], now: number = Date.now()): number | null {
  let best: number | null = null;
  for (const r of rows) {
    for (const t of [ms(r.expires_at), ms(r.publish_at)]) {
      if (Number.isFinite(t) && t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** Rows to show right now: not expired, not unsent, not scheduled for later. */
export function visibleNow<T extends { expires_at?: string | null; unsent_at?: string | null; publish_at?: string | null }>(rows: T[], now: number = Date.now()): T[] {
  return rows.filter((r) => !r.unsent_at && !isExpired(r, now) && !isScheduled(r, now));
}

/** Coarse "time left" for a badge: the largest whole unit (minutes, hours or days), at least 1 minute. */
export function timeLeft(expiresAt: string, now: number = Date.now()): { unit: 'minute' | 'hour' | 'day'; count: number } {
  const left = Math.max(0, ms(expiresAt) - now);
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  if (minutes < 60) return { unit: 'minute', count: minutes };
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return { unit: 'hour', count: hours };
  return { unit: 'day', count: Math.ceil(hours / 24) };
}

// ---------------------------------------------------------------------------------------------
// Scheduling. <input type="datetime-local"> speaks the user's local wall-clock time ("2026-10-24T17:30"),
// which the browser's own time zone turns into an instant.

/** At least this far ahead, so a scheduled post is really scheduled (sooner ones just post). */
export const MIN_SCHEDULE_MS = 5 * 60_000;
/** At most this far ahead (the database allows 366 days). */
export const MAX_SCHEDULE_MS = 365 * 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** A Date as the value of a datetime-local input, in local time (minutes precision). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse a datetime-local value as local time; null when malformed. */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const out = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Reject impossible dates (Feb 30 rolls over) — but allow DST gaps, which the Date moves forward.
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) return null;
  return out;
}

export type ScheduleProblem = 'invalid' | 'past' | 'too_soon' | 'too_far';

/** Is this a time a post can be scheduled for? */
export function checkSchedule(d: Date | null, now: number = Date.now()): ScheduleProblem | null {
  if (!d || !Number.isFinite(d.getTime())) return 'invalid';
  const t = d.getTime();
  if (t <= now) return 'past';
  if (t < now + MIN_SCHEDULE_MS) return 'too_soon';
  if (t > now + MAX_SCHEDULE_MS) return 'too_far';
  return null;
}

/** A sensible default for the picker: the next full hour at least an hour from now. */
export function defaultScheduleTime(now: Date = new Date()): Date {
  const d = new Date(now.getTime() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  if (d.getTime() - now.getTime() < 60 * 60_000) d.setHours(d.getHours() + 1);
  return d;
}
