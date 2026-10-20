import { describe, expect, it } from 'vitest';
import {
  checkSchedule, defaultScheduleTime, durationKey, fromLocalInput, isExpired, isMessageTimer, isPostTimer, isScheduled,
  MESSAGE_TIMERS, nextChange, POST_TIMERS, timeLeft, toLocalInput, visibleNow, DEFAULT_MESSAGE_TIMER,
} from './ephemeral';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('timers', () => {
  it('offers the brief\'s choices and defaults chats to 4 weeks', () => {
    expect(MESSAGE_TIMERS).toEqual([null, 86400, 604800, 2419200, 7776000]);
    expect(POST_TIMERS).toEqual([null, 86400, 604800, 2592000]);
    expect(DEFAULT_MESSAGE_TIMER).toBe(4 * 7 * 86400);
  });
  it('names each timer', () => {
    expect(durationKey(null)).toBe('ephemeral.dur.off');
    expect(durationKey(86400)).toBe('ephemeral.dur.day');
    expect(durationKey(604800)).toBe('ephemeral.dur.week');
    expect(durationKey(2419200)).toBe('ephemeral.dur.weeks4');
    expect(durationKey(2592000)).toBe('ephemeral.dur.month');
    expect(durationKey(7776000)).toBe('ephemeral.dur.months3');
  });
  it('validates timer values', () => {
    expect(isMessageTimer(2419200)).toBe(true);
    expect(isMessageTimer(2592000)).toBe(false);
    expect(isPostTimer(2592000)).toBe(true);
    expect(isPostTimer(7776000)).toBe(false);
    expect(isPostTimer(null)).toBe(true);
  });
});

describe('expiry on this device', () => {
  it('knows what has expired', () => {
    expect(isExpired({ expires_at: iso(-1) }, NOW)).toBe(true);
    expect(isExpired({ expires_at: iso(0) }, NOW)).toBe(true);
    expect(isExpired({ expires_at: iso(1000) }, NOW)).toBe(false);
    expect(isExpired({ expires_at: null }, NOW)).toBe(false);
    expect(isExpired({}, NOW)).toBe(false);
  });
  it('knows what is still scheduled', () => {
    expect(isScheduled({ publish_at: iso(60_000) }, NOW)).toBe(true);
    expect(isScheduled({ publish_at: iso(-60_000) }, NOW)).toBe(false);
    expect(isScheduled({ publish_at: null }, NOW)).toBe(false);
  });
  it('hides expired, unsent and not-yet-published rows', () => {
    const rows = [
      { id: 'a', expires_at: iso(-5) }, { id: 'b', expires_at: iso(5000) }, { id: 'c', unsent_at: iso(-1) },
      { id: 'd', publish_at: iso(5000) }, { id: 'e' },
    ];
    expect(visibleNow(rows, NOW).map((r) => r.id)).toEqual(['b', 'e']);
  });
  it('finds the next moment something changes', () => {
    expect(nextChange([{ expires_at: iso(-5) }, { expires_at: iso(9000) }, { publish_at: iso(3000) }], NOW)).toBe(NOW + 3000);
    expect(nextChange([{ expires_at: null }, {}], NOW)).toBeNull();
  });
  it('rounds the time left to a friendly unit', () => {
    expect(timeLeft(iso(30_000), NOW)).toEqual({ unit: 'minute', count: 1 });
    expect(timeLeft(iso(59 * 60_000), NOW)).toEqual({ unit: 'minute', count: 59 });
    expect(timeLeft(iso(3 * 3600_000), NOW)).toEqual({ unit: 'hour', count: 3 });
    expect(timeLeft(iso(6 * 86400_000), NOW)).toEqual({ unit: 'day', count: 6 });
    expect(timeLeft(iso(-1), NOW)).toEqual({ unit: 'minute', count: 1 });
  });
});

describe('scheduling', () => {
  it('round-trips datetime-local values in local time', () => {
    const d = new Date(2026, 9, 24, 17, 30);
    expect(toLocalInput(d)).toBe('2026-10-24T17:30');
    expect(fromLocalInput('2026-10-24T17:30')?.getTime()).toBe(d.getTime());
  });
  it('rejects malformed and impossible dates', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('2026-02-30T10:00')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
  });
  it('checks the window', () => {
    expect(checkSchedule(null, NOW)).toBe('invalid');
    expect(checkSchedule(new Date(NOW - 1), NOW)).toBe('past');
    expect(checkSchedule(new Date(NOW + 60_000), NOW)).toBe('too_soon');
    expect(checkSchedule(new Date(NOW + 366 * 86400_000), NOW)).toBe('too_far');
    expect(checkSchedule(new Date(NOW + 3600_000), NOW)).toBeNull();
  });
  it('suggests the next full hour at least an hour away', () => {
    const now = new Date(2026, 9, 24, 10, 20);
    const d = defaultScheduleTime(now);
    expect(d.getMinutes()).toBe(0);
    expect(d.getTime() - now.getTime()).toBeGreaterThanOrEqual(3600_000);
    expect(d.getTime() - now.getTime()).toBeLessThan(2 * 3600_000);
    expect(checkSchedule(d, now.getTime())).toBeNull();
  });
});
