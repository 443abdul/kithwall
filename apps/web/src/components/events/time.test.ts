import { describe, expect, it } from 'vitest';
import { checkTimes, isValidTimeZone, splitByTime, tzOffsetMs, utcToZonedInput, zonedToUtc } from './time';

describe('event time zones', () => {
  it('converts wall-clock time in a zone to UTC', () => {
    expect(zonedToUtc('2026-11-05T19:30', 'Asia/Karachi')).toBe('2026-11-05T14:30:00.000Z');
    expect(zonedToUtc('2026-07-01T09:00', 'Europe/London')).toBe('2026-07-01T08:00:00.000Z');
    expect(zonedToUtc('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z');
    expect(zonedToUtc('2026-03-10T12:00', 'Asia/Kolkata')).toBe('2026-03-10T06:30:00.000Z');
    expect(zonedToUtc('2026-06-01T20:00', 'America/New_York')).toBe('2026-06-02T00:00:00.000Z');
    expect(zonedToUtc('nope', 'UTC')).toBeNull();
  });

  it('handles daylight-saving transitions', () => {
    // 2026-03-29 01:30 does not exist in London (clocks jump 01:00 → 02:00); we land on a real instant.
    const iso = zonedToUtc('2026-03-29T01:30', 'Europe/London')!;
    expect(['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z']).toContain(iso);
    expect(zonedToUtc('2026-10-25T12:00', 'Europe/London')).toBe('2026-10-25T12:00:00.000Z');
  });

  it('round-trips for editing', () => {
    for (const tz of ['UTC', 'Asia/Tehran', 'America/Sao_Paulo', 'Asia/Shanghai']) {
      const iso = zonedToUtc('2026-12-24T18:45', tz)!;
      expect(utcToZonedInput(iso, tz)).toBe('2026-12-24T18:45');
    }
  });

  it('computes offsets', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 1), 'UTC')).toBe(0);
    expect(tzOffsetMs(Date.UTC(2026, 0, 1), 'Asia/Kolkata')).toBe(5.5 * 3600_000);
  });

  it('validates zones', () => {
    expect(isValidTimeZone('Asia/Dhaka')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});

describe('upcoming and past', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const items = [
    { id: 'a', start: '2026-10-25T10:00:00Z' },
    { id: 'b', start: '2026-10-21T10:00:00Z' },
    { id: 'c', start: '2026-10-01T10:00:00Z' },
    { id: 'd', start: '2026-10-20T10:00:00Z' }, // started 2 h ago, default 3 h → still on
    { id: 'e', start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z' },
    { id: 'f', start: 'garbage' },
  ];
  it('splits and sorts', () => {
    const r = splitByTime(items, (x) => x, now);
    expect(r.upcoming.map((x) => x.id)).toEqual(['d', 'b', 'a']);
    expect(r.past.map((x) => x.id)).toEqual(['e', 'c']);
    expect(r.unknown.map((x) => x.id)).toEqual(['f']);
  });
  it('checks form times', () => {
    expect(checkTimes(null, null)).toBe('start');
    expect(checkTimes('2026-10-20T10:00:00Z', '2026-10-20T09:00:00Z')).toBe('order');
    expect(checkTimes('2026-10-20T10:00:00Z', null)).toBeNull();
  });
});
