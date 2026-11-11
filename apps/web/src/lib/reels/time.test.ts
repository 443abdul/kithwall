// Time controls for reels (docs/v2/12-reels.md §4). Run: npx vitest run src/lib/reels
import { describe, expect, it } from 'vitest';
import { addWatch, breakDue, cleanTime, defaultTime, dismissLimit, limitReached, localDay, watchedToday, type ReelTime } from './time';

const at = (h: number, m = 0, day = 11) => new Date(2026, 10, day, h, m);

describe('reels time controls', () => {
  it('is off by default', () => {
    const t = defaultTime();
    expect(t.limitMin).toBe(0);
    expect(t.breakMin).toBe(0);
    expect(limitReached(addWatch(t, 5 * 3600, at(10)), at(10))).toBe(false);
    expect(breakDue(0, 9999, 0)).toBe(false);
  });

  it('counts per local day and starts again at midnight', () => {
    let t = addWatch(defaultTime(), 600, at(23, 50));
    expect(t.day).toBe('2026-11-11');
    expect(watchedToday(t, at(23, 59))).toBe(600);
    expect(watchedToday(t, at(0, 5, 12))).toBe(0);
    t = addWatch(t, 30, at(0, 5, 12));
    expect(t).toMatchObject({ day: '2026-11-12', secs: 30 });
    expect(localDay(new Date(2026, 0, 3, 9))).toBe('2026-01-03');
  });

  it('reaches the limit I set, and can be dismissed for today only', () => {
    let t: ReelTime = { ...defaultTime(), limitMin: 15 };
    t = addWatch(t, 14 * 60, at(9));
    expect(limitReached(t, at(9))).toBe(false);
    t = addWatch(t, 60, at(9, 20));
    expect(limitReached(t, at(9, 20))).toBe(true);
    const kept = dismissLimit(t, at(9, 21));
    expect(limitReached(kept, at(22))).toBe(false);
    // Tomorrow the count is fresh, and so is the limit.
    const tomorrow = addWatch(kept, 15 * 60, at(8, 0, 12));
    expect(limitReached(tomorrow, at(8, 0, 12))).toBe(true);
  });

  it('reminds about a break every N minutes of one sitting', () => {
    expect(breakDue(10, 9 * 60 + 59, 0)).toBe(false);
    expect(breakDue(10, 10 * 60, 0)).toBe(true);
    expect(breakDue(10, 15 * 60, 10 * 60)).toBe(false);
    expect(breakDue(10, 20 * 60, 10 * 60)).toBe(true);
  });

  it('ignores nonsense read back from storage', () => {
    expect(cleanTime({ limitMin: 17, breakMin: '10', day: 'today', secs: -4, dismissedDay: 5 })).toEqual(defaultTime());
    expect(cleanTime({ limitMin: 30, breakMin: 20, day: '2026-11-11', secs: 120, dismissedDay: '2026-11-11' }))
      .toEqual({ limitMin: 30, breakMin: 20, day: '2026-11-11', secs: 120, dismissedDay: '2026-11-11' });
    expect(cleanTime(undefined)).toEqual(defaultTime());
    expect(addWatch(defaultTime(), -3, at(9))).toEqual(defaultTime());
  });
});
