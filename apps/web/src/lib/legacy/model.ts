// Legacy contact (docs/v2/03-safety.md §11): pure helpers shared by the settings screens, the note sealing
// and the tests. Dates are UTC calendar days ("YYYY-MM-DD"), like the database's current_date.

export const LEGACY_MONTHS = [3, 6, 12] as const;
export type LegacyMonths = (typeof LEGACY_MONTHS)[number];

/** The longest farewell note, in characters (the UI counts these). */
export const NOTE_MAX = 5000;
/** Its longest encoding, in bytes, before padding (keeps both sealed copies inside the column limits). */
export const NOTE_MAX_BYTES = 20_000;

/** Reminders go out about this many days before the end of the period (legacy_tick in the migration). */
export const REMINDER_DAYS = [30, 7] as const;

export const isLegacyMonths = (n: unknown): n is LegacyMonths => n === 3 || n === 6 || n === 12;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today as a UTC calendar day. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const x = DAY_RE.exec(day);
  if (!x) throw new Error(`not a day: ${day}`);
  return { y: Number(x[1]), m: Number(x[2]), d: Number(x[3]) };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * `day` plus whole months, as Postgres adds `make_interval(months => n)` to a date: the day of the month is
 * kept, or clamped to the last day of a shorter month (31 January + 1 month = 28 or 29 February).
 */
export function addMonths(day: string, months: number): string {
  const { y, m, d } = parseDay(day);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, last))}`;
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** The last day of the inactivity period (kw.legacy_due). */
export function legacyDueOn(lastActiveOn: string, months: number): string {
  return addMonths(lastActiveOn, months);
}

// ---------------------------------------------------------------------------------------------- note payload

export interface NotePayload { v: 1; text: string; at: string }

/**
 * The note's plaintext: canonical JSON padded with spaces to a multiple of 512 bytes (at least 1 KiB), so the
 * ciphertext only shows roughly how long the note is. JSON.parse ignores the padding.
 */
export function encodeNote(text: string, at = new Date().toISOString()): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify({ v: 1, text, at } satisfies NotePayload));
  if (raw.length > NOTE_MAX_BYTES + 200) throw new Error('note too long');
  const size = Math.max(1024, Math.ceil(raw.length / 512) * 512);
  const out = new Uint8Array(size).fill(0x20);
  out.set(raw);
  return out;
}

export function decodeNote(bytes: Uint8Array): NotePayload {
  const p = JSON.parse(new TextDecoder().decode(bytes)) as Partial<NotePayload>;
  if (p?.v !== 1 || typeof p.text !== 'string' || typeof p.at !== 'string') throw new Error('malformed note');
  return { v: 1, text: p.text, at: p.at };
}

/** Does the note fit? (characters for the person, bytes for the database) */
export function noteFits(text: string): boolean {
  return text.length <= NOTE_MAX && new TextEncoder().encode(text).length <= NOTE_MAX_BYTES;
}
