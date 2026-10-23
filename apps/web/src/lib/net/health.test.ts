// When the connection banner may appear (health.ts). Run: npx vitest run src/lib/net
import { describe, expect, it } from 'vitest';
import {
  BAD_SAMPLES, BAD_SPAN_MS, BLOCKED_NO_MIRROR_SPAN_MS, classify, HEALTH_START, nextCheckIn, nextHealth, probeOutcome,
  type HealthSample, type HealthTrack,
} from './health';

const ok: Omit<HealthSample, 'at'> = { online: true, hidden: false, app: 'ok', route: 'ok', rerouted: false };
const S = (at: number, p: Partial<HealthSample> = {}): HealthSample => ({ ...ok, at, ...p });

function run(samples: HealthSample[], mirrors = true): HealthTrack[] {
  const out: HealthTrack[] = [];
  let t = HEALTH_START;
  for (const s of samples) { t = nextHealth(t, s, { mirrors }); out.push(t); }
  return out;
}

describe('probe outcomes', () => {
  it('counts only network-level failures and censor pages against the network', () => {
    expect(probeOutcome({ status: 200, contentType: 'application/json; charset=utf-8' })).toBe('ok');
    expect(probeOutcome({ status: 200, contentType: 'text/html' })).toBe('fail');
    expect(probeOutcome({ status: 403, contentType: 'text/html' })).toBe('fail');
    expect(probeOutcome({ status: 451, contentType: 'application/json' })).toBe('fail');
    // The server answered with its own error: the path works.
    expect(probeOutcome({ status: 401, contentType: 'application/json' })).toBe('neutral');
    expect(probeOutcome({ status: 503, contentType: 'text/html' })).toBe('neutral');
    expect(probeOutcome({ status: 500, contentType: 'application/json' })).toBe('neutral');
    expect(probeOutcome({ error: new TypeError('Failed to fetch'), timedOut: false })).toBe('fail');
    expect(probeOutcome({ error: Object.assign(new Error('x'), { name: 'AbortError' }), timedOut: true })).toBe('fail');
    expect(probeOutcome({ error: Object.assign(new Error('x'), { name: 'AbortError' }), timedOut: false })).toBe('aborted');
  });

  it('classifies a sample', () => {
    expect(classify(S(0))).toBe('direct');
    expect(classify(S(0, { rerouted: true }))).toBe('rerouted');
    expect(classify(S(0, { route: 'neutral' }))).toBe('direct');
    expect(classify(S(0, { online: false, app: 'fail', route: 'fail' }))).toBe('offline');
    expect(classify(S(0, { app: 'fail', route: 'fail' }))).toBe('unreachable');
    expect(classify(S(0, { route: 'fail' }))).toBe('blocked');
    expect(classify(S(0, { app: 'fail' }))).toBe('blocked');
    expect(classify(S(0, { hidden: true, app: 'fail', route: 'fail' }))).toBeNull();
    expect(classify(S(0, { app: 'aborted', route: 'fail' }))).toBeNull();
  });
});

describe('the banner needs sustained failure', () => {
  it('never shows after one failed check (a cold start, a resume, a network switch)', () => {
    const [a, b] = run([S(0, { route: 'fail' }), S(5_000)]);
    expect(a!.status).toBe('unknown');
    expect(a!.pending).toBe('blocked');
    expect(b!.status).toBe('direct');
    expect(b!.pending).toBeNull();
  });

  it('shows "blocked" only after enough failures over enough time, and clears on one good check', () => {
    const times = [0, 5_000, 13_000, 25_000, 45_000];
    const t = run(times.map((at) => S(at, { route: 'fail' })));
    // Three failures, but within 13 s: not yet.
    expect(t[2]!.status).toBe('unknown');
    expect(t[2]!.streak).toBe(BAD_SAMPLES);
    // ≥ BAD_SPAN_MS since the first one: shown.
    expect(25_000).toBeGreaterThanOrEqual(BAD_SPAN_MS);
    expect(t[3]!.status).toBe('blocked');
    const cleared = nextHealth(t[4]!, S(50_000), { mirrors: true });
    expect(cleared).toMatchObject({ status: 'direct', pending: null, streak: 0 });
  });

  it('a good check in between restarts the count', () => {
    const t = run([S(0, { route: 'fail' }), S(10_000, { route: 'fail' }), S(20_000), S(30_000, { route: 'fail' }), S(40_000, { route: 'fail' }), S(50_000, { route: 'fail' })]);
    expect(t.every((x) => x.status !== 'blocked')).toBe(true);
  });

  it('hidden pages and aborted checks change nothing', () => {
    const t = run([S(0, { route: 'fail' }), S(10_000, { hidden: true, route: 'fail' }), S(20_000, { app: 'aborted', route: 'aborted' }), S(30_000, { route: 'fail' })]);
    expect(t[3]).toMatchObject({ status: 'unknown', streak: 2 });
  });

  it('server errors from Supabase or our own routes are not "blocked"', () => {
    const t = run([0, 10_000, 20_000, 30_000, 40_000].map((at) => S(at, { route: 'neutral', app: 'neutral' })));
    expect(t.at(-1)!.status).toBe('direct');
  });

  it('nothing answering at all is "unreachable" (calm), not "blocked"', () => {
    const t = run([0, 10_000, 20_000, 30_000].map((at) => S(at, { app: 'fail', route: 'fail' })));
    expect(t.at(-1)!.status).toBe('unreachable');
  });

  it('the browser saying "offline" is shown sooner, and replaced by the real state when it changes', () => {
    const t = run([S(0, { online: false }), S(3_000, { online: false }), S(7_000, { online: false })]);
    expect(t[1]!.status).toBe('unknown');
    expect(t[2]!.status).toBe('offline');
    expect(nextHealth(t[2]!, S(9_000), { mirrors: true }).status).toBe('direct');
  });

  it('without a mirror to offer, "blocked" needs to be clearer still', () => {
    const times = [0, 10_000, 20_000, 30_000, 45_000, 60_000];
    const t = run(times.map((at) => S(at, { route: 'fail' })), false);
    expect(t[3]!.status).toBe('unknown');
    expect(t[4]!.status).toBe('unknown');
    expect(60_000).toBeGreaterThanOrEqual(BLOCKED_NO_MIRROR_SPAN_MS);
    expect(t[5]!.status).toBe('blocked');
  });
});

describe('check scheduling', () => {
  it('confirms quickly while pending, backs off once shown, and stays quiet when fine', () => {
    expect(nextCheckIn(HEALTH_START)).toBeNull();
    expect(nextCheckIn({ status: 'direct', pending: null, streak: 0, since: 0 })).toBeNull();
    expect(nextCheckIn({ status: 'rerouted', pending: null, streak: 0, since: 0 })).toBe(300_000);
    expect(nextCheckIn({ status: 'direct', pending: 'blocked', streak: 1, since: 0 })).toBe(5_000);
    expect(nextCheckIn({ status: 'direct', pending: 'blocked', streak: 9, since: 0 })).toBe(30_000);
    const shown = (streak: number): HealthTrack => ({ status: 'blocked', pending: 'blocked', streak, since: 0 });
    expect(nextCheckIn(shown(3))).toBe(30_000);
    expect(nextCheckIn(shown(4))).toBe(60_000);
    expect(nextCheckIn(shown(20))).toBe(300_000);
  });
});
