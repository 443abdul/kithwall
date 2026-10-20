// Event times (pure; unit-tested in time.test.ts). Events store their start/end as UTC ISO strings plus
// the IANA time zone the host picked, all inside the encrypted envelope. The form edits wall-clock
// time ("2026-11-05T19:30") in that zone.

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of Greenwich). */
export function tzOffsetMs(ms: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Wall-clock "YYYY-MM-DDTHH:mm" in `tz` → UTC ISO string (null if malformed). */
export function zonedToUtc(local: string, tz: string): string | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  let ms = guess - tzOffsetMs(guess, tz);
  const second = tzOffsetMs(ms, tz);
  if (guess - second !== ms) ms = guess - second; // across a DST change
  return new Date(ms).toISOString();
}

/** UTC ISO → wall-clock "YYYY-MM-DDTHH:mm" in `tz` (for editing). */
export function utcToZonedInput(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  const d = new Date(ms + tzOffsetMs(ms, tz));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Time zones for the picker (the device zone first). */
export function timeZoneList(): string[] {
  const own = deviceTimeZone();
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { /* old engine */ }
  if (!all.length) all = ['UTC', 'Europe/London', 'Europe/Paris', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Tehran', 'Asia/Riyadh', 'Asia/Shanghai', 'Europe/Moscow', 'Europe/Istanbul', 'America/New_York', 'America/Sao_Paulo', 'America/Mexico_City'];
  return [own, ...all.filter((z) => z !== own)];
}

export interface Timed { start: string; end?: string }

/** Default length when no end time is given (matches v1 lib/events.ts isPast/eventIcs). */
export const DEFAULT_LENGTH_MS = 3 * 3600_000;

export function endMs(e: Timed): number {
  return e.end ? Date.parse(e.end) : Date.parse(e.start) + DEFAULT_LENGTH_MS;
}

/** Upcoming (not yet ended; soonest first) and past (most recent first). */
export function splitByTime<T>(items: T[], get: (x: T) => Timed | null, now = Date.now()): { upcoming: T[]; past: T[]; unknown: T[] } {
  const upcoming: T[] = [], past: T[] = [], unknown: T[] = [];
  for (const it of items) {
    const tm = get(it);
    if (!tm || Number.isNaN(Date.parse(tm.start))) unknown.push(it);
    else if (endMs(tm) < now) past.push(it);
    else upcoming.push(it);
  }
  upcoming.sort((a, b) => Date.parse(get(a)!.start) - Date.parse(get(b)!.start));
  past.sort((a, b) => Date.parse(get(b)!.start) - Date.parse(get(a)!.start));
  return { upcoming, past, unknown };
}

/** Validate a form's start/end. Returns an error code or null. */
export function checkTimes(startIso: string | null, endIso: string | null): 'start' | 'order' | null {
  if (!startIso) return 'start';
  if (endIso && Date.parse(endIso) <= Date.parse(startIso)) return 'order';
  return null;
}
