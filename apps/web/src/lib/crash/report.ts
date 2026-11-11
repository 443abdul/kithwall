// Crash reports (opt-in): the report itself. One shape, built on the device (client.ts) and checked again
// by the server (app/api/crash/route.ts) with the same code, so what is stored is exactly what the person
// could read under "See what gets sent". Pure; unit-tested in crash.test.ts.
//
// A report says what broke and on what kind of device, and nothing about who: no account id, no session, no
// device id, no IP address, no time from the device, no path (only the route pattern), no content. The only
// identifier is `id`, random per report, so a retried upload isn't counted twice.
import { fingerprintSource, scrubCrash, type RawCrash, type ScrubContext } from './scrub';
import { isRoutePattern, UNKNOWN_ROUTE } from './routes';

export type CrashKind = 'error' | 'rejection' | 'react' | 'native';
export type CrashPlatform = 'web' | 'pwa' | 'android' | 'ios';

export interface CrashReport {
  v: 1;
  /** Random per report (UUID v4). Not derived from anything. */
  id: string;
  /** Where it was caught: an uncaught error, an unhandled promise rejection, a React error boundary, or the Android app itself. */
  kind: CrashKind;
  /** The app build: website commit (or build id), and in the apps the version name and build number. */
  app: { web: string; version: string; build: string };
  platform: CrashPlatform;
  /** Operating system and its major version only ("Android 14"). */
  os: string;
  /** Browser or WebView and its major version only ("Chrome 141"). */
  browser: string;
  /** Route pattern ("/messages/[id]"), never the path. */
  route: string;
  /** Interface language ("ur"). */
  locale: string;
  name: string;
  message: string;
  stack: string;
  componentStack: string;
}

/** Hard cap on a transmitted report (the server refuses anything larger before parsing it). */
export const REPORT_MAX_BYTES = 12_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS: readonly CrashKind[] = ['error', 'rejection', 'react', 'native'];
const PLATFORMS: readonly CrashPlatform[] = ['web', 'pwa', 'android', 'ios'];
/** "Android 14", "Windows", "Chrome 141", "Samsung Internet 27": a name and at most a major version. */
const AGENT = /^[A-Za-z][A-Za-z ]{0,23}(?: \d{1,3})?$/;
const BUILD = /^[A-Za-z0-9._+-]{0,40}$/;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/** OS and browser family with major versions, from a user-agent string. Never the full string. */
export function describeAgent(ua: string): { os: string; browser: string } {
  const u = ua.slice(0, 600);
  const major = (re: RegExp) => { const m = re.exec(u); return m ? ` ${Number(m[1])}` : ''; };
  let os = 'Other';
  if (/Android/i.test(u)) os = `Android${major(/Android (\d{1,2})/i)}`;
  else if (/iPhone|iPad|iPod/i.test(u)) os = `iOS${major(/OS (\d{1,2})[_.]/)}`;
  else if (/CrOS/.test(u)) os = 'ChromeOS';
  else if (/Windows/i.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(u)) os = 'macOS';
  else if (/Linux|X11/i.test(u)) os = 'Linux';
  let browser = 'Other';
  if (/; wv\)/.test(u) || /\bVersion\/[\d.]+ Chrome\//.test(u)) browser = `WebView${major(/Chrome\/(\d{1,3})/)}`;
  else if (/\bEdg(?:e|A|iOS)?\/(\d{1,3})/.test(u)) browser = `Edge${major(/\bEdg(?:e|A|iOS)?\/(\d{1,3})/)}`;
  else if (/SamsungBrowser\//.test(u)) browser = `Samsung Internet${major(/SamsungBrowser\/(\d{1,3})/)}`;
  else if (/\bOPR\//.test(u)) browser = `Opera${major(/\bOPR\/(\d{1,3})/)}`;
  else if (/Firefox\/|FxiOS\//.test(u)) browser = `Firefox${major(/(?:Firefox|FxiOS)\/(\d{1,3})/)}`;
  else if (/Chrome\/|CriOS\//.test(u)) browser = `Chrome${major(/(?:Chrome|CriOS)\/(\d{1,3})/)}`;
  else if (/Safari\//.test(u) && /Version\//.test(u)) browser = `Safari${major(/Version\/(\d{1,3})/)}`;
  else if (/AppleWebKit\//.test(u) && os.startsWith('iOS')) browser = 'WebView';
  return { os, browser };
}

export interface ReportInput extends RawCrash {
  kind: CrashKind;
  app: { web?: string; version?: string; build?: string };
  platform: CrashPlatform;
  userAgent: string;
  /** The page path it happened on; only its route pattern goes into the report. */
  pathname: string;
  locale: string;
}

const fit = (re: RegExp, v: unknown, fallback = ''): string => (typeof v === 'string' && re.test(v) ? v : fallback);

/** Build a report on the device. `id` and `ctx` come from the caller so this stays pure. */
export function buildReport(input: ReportInput, id: string, ctx: ScrubContext): CrashReport {
  const agent = describeAgent(input.userAgent);
  const e = scrubCrash(input, ctx);
  return {
    v: 1, id, kind: input.kind,
    app: { web: fit(BUILD, input.app.web), version: fit(BUILD, input.app.version), build: fit(BUILD, input.app.build) },
    platform: input.platform, os: agent.os, browser: agent.browser,
    route: ctx.route(input.pathname), locale: fit(LOCALE, input.locale, 'en'),
    name: e.name, message: e.message, stack: e.stack, componentStack: e.componentStack,
  };
}

/**
 * The server's reading of a received report: strict about shape (anything unexpected → null), and the
 * error text is scrubbed again with the server's own context, so only scrubbed text is ever stored.
 * Unknown keys are dropped: a client can't attach extra fields.
 */
export function parseReport(body: unknown, ctx: ScrubContext): CrashReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || typeof b.id !== 'string' || !UUID.test(b.id)) return null;
  if (!KINDS.includes(b.kind as CrashKind) || !PLATFORMS.includes(b.platform as CrashPlatform)) return null;
  const app = (b.app && typeof b.app === 'object' && !Array.isArray(b.app) ? b.app : {}) as Record<string, unknown>;
  for (const k of ['name', 'message', 'stack', 'componentStack', 'os', 'browser', 'route', 'locale'] as const) {
    if (typeof b[k] !== 'string') return null;
  }
  for (const k of ['web', 'version', 'build'] as const) if (typeof app[k] !== 'string' || !BUILD.test(app[k])) return null;
  if (!AGENT.test(b.os as string) || !AGENT.test(b.browser as string) || !LOCALE.test(b.locale as string)) return null;
  const e = scrubCrash(b, ctx);
  if (!e.stack && !e.message) return null;
  return {
    v: 1, id: b.id, kind: b.kind as CrashKind,
    app: { web: app.web as string, version: app.version as string, build: app.build as string },
    platform: b.platform as CrashPlatform, os: b.os as string, browser: b.browser as string,
    route: isRoutePattern(b.route) ? b.route : UNKNOWN_ROUTE, locale: b.locale as string,
    name: e.name, message: e.message, stack: e.stack, componentStack: e.componentStack,
  };
}

/** What the server hashes into the grouping fingerprint (the same bug from different people groups together). */
export function reportFingerprintSource(r: Pick<CrashReport, 'kind' | 'name' | 'stack' | 'message'>): string {
  // No usable stack (some rejections carry none): group by the message instead.
  return `${r.kind === 'native' ? 'native' : 'web'}\n${fingerprintSource(r.name, r.stack || r.message)}`;
}

/** Errors that say nothing about a bug in the app: never reported. */
export function isNoise(name: string, message: string): boolean {
  if (name === 'AbortError' || name === 'NotAllowedError' || name === 'QuotaExceededError') return true;
  return /^(?:Script error\.?|ResizeObserver loop|Failed to fetch|Load failed|NetworkError|Network request failed|The operation was aborted|cancelled$)/i.test(message.trim())
    || /Loading (?:CSS )?chunk [\w-]+ failed|Failed to load chunk/i.test(message);
}
