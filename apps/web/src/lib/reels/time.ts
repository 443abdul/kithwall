// Reels: time controls (docs/v2/12-reels.md §4). Pure and unit-tested (time.test.ts).
//
// Both are off until the person turns them on, and both live only on this device (./store.ts): an optional
// daily limit for reels (15 / 30 / 45 / 60 minutes) with a calm "You've reached the limit you set" screen
// that can be dismissed for the rest of the day, and an optional "take a break" reminder every N minutes of
// one sitting. The time counted is time a reel was actually playing in front of the person.

export const LIMIT_CHOICES = [0, 15, 30, 45, 60] as const;
export const BREAK_CHOICES = [0, 10, 20, 30] as const;
export type LimitMinutes = (typeof LIMIT_CHOICES)[number];
export type BreakMinutes = (typeof BREAK_CHOICES)[number];

export interface ReelTime {
  /** Daily limit in minutes; 0 = off. */
  limitMin: LimitMinutes;
  /** Remind me to take a break after this many minutes in one sitting; 0 = off. */
  breakMin: BreakMinutes;
  /** The local day `secs` belongs to (YYYY-MM-DD). */
  day: string;
  /** Seconds of reels watched on `day`. */
  secs: number;
  /** The day on which I dismissed the limit screen ("keep watching today"). */
  dismissedDay: string | null;
}

export const defaultTime = (): ReelTime => ({ limitMin: 0, breakMin: 0, day: '', secs: 0, dismissedDay: null });

/** The local calendar day, so the count starts again at the person's own midnight. */
export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Time settings read from storage: anything unexpected falls back to "off". */
export function cleanTime(v: unknown): ReelTime {
  const out = defaultTime();
  if (!v || typeof v !== 'object') return out;
  const x = v as Partial<Record<keyof ReelTime, unknown>>;
  if ((LIMIT_CHOICES as readonly unknown[]).includes(x.limitMin)) out.limitMin = x.limitMin as LimitMinutes;
  if ((BREAK_CHOICES as readonly unknown[]).includes(x.breakMin)) out.breakMin = x.breakMin as BreakMinutes;
  if (typeof x.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.day)) out.day = x.day;
  if (typeof x.secs === 'number' && Number.isFinite(x.secs) && x.secs >= 0) out.secs = Math.min(x.secs, 86_400);
  if (typeof x.dismissedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.dismissedDay)) out.dismissedDay = x.dismissedDay;
  return out;
}

/** Today's count (zero when the stored count is from another day). */
export function watchedToday(t: ReelTime, now: Date): number {
  return t.day === localDay(now) ? t.secs : 0;
}

/** Add watched seconds to today's count (a new day starts from zero). */
export function addWatch(t: ReelTime, secs: number, now: Date): ReelTime {
  if (!(secs > 0)) return t;
  const day = localDay(now);
  return { ...t, day, secs: Math.min(86_400, (t.day === day ? t.secs : 0) + secs) };
}

/** Has the limit I set been reached today (and not been dismissed for today)? */
export function limitReached(t: ReelTime, now: Date): boolean {
  if (!t.limitMin) return false;
  const day = localDay(now);
  if (t.dismissedDay === day) return false;
  return watchedToday(t, now) >= t.limitMin * 60;
}

/** "Keep watching today": the limit screen stays away until tomorrow. */
export function dismissLimit(t: ReelTime, now: Date): ReelTime {
  return { ...t, dismissedDay: localDay(now) };
}

/**
 * Is a break reminder due? `sittingSecs`: seconds watched since the reels screen was opened;
 * `lastBreakAt`: the value of `sittingSecs` when the last reminder was shown (0 = none yet).
 */
export function breakDue(breakMin: number, sittingSecs: number, lastBreakAt: number): boolean {
  if (!breakMin) return false;
  return sittingSecs - lastBreakAt >= breakMin * 60;
}
