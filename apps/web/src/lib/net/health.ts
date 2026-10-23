// When to tell someone "Kithwall seems blocked here" or "you're offline" (docs/v2/08-censorship.md §3).
// Pure: the runtime (runtime.ts) feeds it one sample per health check and shows what comes out; vitest
// drives it with synthetic samples (health.test.ts).
//
// The banner used to appear after ONE failed check: a serverless cold start, a phone waking up, a
// Wi-Fi ↔ mobile-data switch or a Realtime reconnect was enough to say "blocked". Now:
//  - a check is only a sample. Aborted requests, checks while the page is hidden, and HTTP errors from a
//    server that did answer (4xx/5xx with a JSON body: the path works, the app is just unhappy) never
//    count against the network;
//  - a bad state is shown only after several failed checks in a row spread over a while
//    (BAD_SAMPLES over BAD_SPAN_MS; longer when there is no mirror to offer);
//  - one good check clears it at once;
//  - "offline" (the browser says so, or nothing answers at all, not even our own static file) is told
//    apart from "blocked" (our app answers but its servers don't, or the other way round), with calmer
//    wording: an outage of your own connection is not censorship.
// No third party is ever asked: "is the internet up?" is inferred from our own origin's static file.
import type { NetStatus } from './endpoints';

/** One probe: answered as expected, failed at the network level (or a censor's HTML page), or no verdict. */
export type Probe = 'ok' | 'fail' | 'neutral' | 'aborted';

export interface HealthSample {
  at: number;
  /** navigator.onLine (false = the device itself has no network). */
  online: boolean;
  /** The page was hidden while checking (timers throttled, radios asleep): no verdict. */
  hidden: boolean;
  /** Our own origin: a static same-origin JSON file (no serverless function, no cold start). */
  app: Probe;
  /** The best backend route (Supabase directly, a proxy or a mirror). */
  route: Probe;
  /** The working route is not the first one. */
  rerouted: boolean;
}

export type Bad = 'offline' | 'unreachable' | 'blocked';

export interface HealthTrack {
  status: NetStatus;
  /** The bad state the samples point at (shown once it has lasted). */
  pending: Bad | null;
  /** Consecutive bad samples, and when the first of them was taken. */
  streak: number;
  since: number;
}

export const HEALTH_START: HealthTrack = { status: 'unknown', pending: null, streak: 0, since: 0 };

/** Failed checks in a row, over at least this long, before anything is shown. */
export const BAD_SAMPLES = 3;
export const BAD_SPAN_MS = 25_000;
/** Without a mirror to offer, "blocked" must be clearer still (it only points to the help page). */
export const BLOCKED_NO_MIRROR_SAMPLES = 4;
export const BLOCKED_NO_MIRROR_SPAN_MS = 60_000;
/** The browser itself says it is offline: shorter, it is not a guess. */
export const OFFLINE_SAMPLES = 2;
export const OFFLINE_SPAN_MS = 6_000;

/** What a single sample says, or null when it says nothing. */
export function classify(s: HealthSample): NetStatus | null {
  if (s.hidden) return null;
  if (!s.online) return 'offline';
  if (s.app === 'aborted' || s.route === 'aborted') return null;
  const appUp = s.app !== 'fail';
  const routeUp = s.route !== 'fail';
  if (appUp && routeUp) return s.route === 'ok' && s.rerouted ? 'rerouted' : 'direct';
  // Nothing answers at all, not even our own static file: most likely this connection is down (a captive
  // portal, no data left, a dead Wi-Fi). Said calmly; the help page is offered for "other apps work".
  if (!appUp && !routeUp) return 'unreachable';
  return 'blocked';
}

const isBad = (s: NetStatus | null): s is Bad => s === 'offline' || s === 'unreachable' || s === 'blocked';

/** Fold one sample into the track. `mirrors`: is there anything to offer besides the help page? */
export function nextHealth(prev: HealthTrack, s: HealthSample, opts: { mirrors: boolean }): HealthTrack {
  const c = classify(s);
  if (c === null) return prev;
  if (!isBad(c)) return { status: c, pending: null, streak: 0, since: 0 };
  const streak = prev.pending ? prev.streak + 1 : 1;
  const since = prev.pending ? prev.since : s.at;
  const [need, span] = c === 'offline' ? [OFFLINE_SAMPLES, OFFLINE_SPAN_MS]
    : c === 'blocked' && !opts.mirrors ? [BLOCKED_NO_MIRROR_SAMPLES, BLOCKED_NO_MIRROR_SPAN_MS]
      : [BAD_SAMPLES, BAD_SPAN_MS];
  const lasted = streak >= need && s.at - since >= span;
  // Already showing a bad state: switch wording straight away (offline → blocked is still "bad").
  const status = lasted || isBad(prev.status) ? c : prev.status;
  return { status, pending: c, streak, since };
}

/**
 * When to check again. Nothing wrong: only when something fails (the runtime reports failures) or every
 * few minutes while rerouted. Something looks wrong but isn't shown yet: soon, to confirm or clear it.
 * Shown: back off (30 s → 5 min), and immediately when the browser comes back online.
 */
export function nextCheckIn(t: HealthTrack): number | null {
  if (t.pending && !isBad(t.status)) return [5_000, 8_000, 12_000, 20_000, 30_000][Math.min(t.streak - 1, 4)]!;
  if (isBad(t.status)) return Math.min(300_000, 30_000 * 2 ** Math.max(0, t.streak - BAD_SAMPLES));
  if (t.status === 'rerouted') return 300_000;
  return null;
}

/** Classify a fetch outcome. `timedOut`: our own timer aborted it (that's a failure, not an abort). */
export function probeOutcome(r: { status: number; contentType: string } | { error: unknown; timedOut: boolean }): Probe {
  if ('error' in r) {
    if (r.timedOut) return 'fail';
    return (r.error as { name?: string } | null)?.name === 'AbortError' ? 'aborted' : 'fail';
  }
  const json = r.contentType.includes('json');
  if (r.status >= 200 && r.status < 300) return json ? 'ok' : 'fail';
  // 451 Unavailable For Legal Reasons is a censor saying so.
  if (r.status === 451) return 'fail';
  // The server answered with its own error (JSON from Supabase / our routes, or a 5xx while it restarts):
  // the network path works; that's an app problem, never "blocked".
  if (json || r.status >= 500) return 'neutral';
  // Anything else (an HTML 200/403 "this site is blocked" page from a middlebox, a captive portal).
  return 'fail';
}
