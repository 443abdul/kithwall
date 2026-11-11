'use client';
// Crash reports (opt-in, Settings → Your data): the reporter. Loaded only while "Send crash reports" is on
// (lib/crash/prefs.ts decides; components/crash/CrashRuntime.tsx imports this on demand).
//
// Caught here: uncaught errors and unhandled promise rejections of the page, what React's error boundaries
// hand over (app/error.tsx, app/global-error.tsx), and in the Android app a crash of the app itself, written
// down by its UncaughtExceptionHandler (KwCrash.java) and picked up on the next start.
//
// Every report is built and scrubbed on this device (report.ts, scrub.ts), kept as the "last report" exactly
// as sent, and posted to this app's own origin (/api/crash) without cookies or any credential. Nothing here
// knows who is signed in, and nothing here may ever read it.
import { isNative, nativePlatform, nativePlugin } from '../native';
import { COMMIT_SHA } from '../source';
import { crashReportsOn, LAST_KEY } from './prefs';
import { buildReport, isNoise, REPORT_MAX_BYTES, type CrashKind, type CrashPlatform, type CrashReport } from './report';
import { routePattern, UNKNOWN_ROUTE } from './routes';
import type { ScrubContext } from './scrub';

const ENDPOINT = '/api/crash';
/** One report that couldn't be sent (offline), tried again at the next start. */
const PENDING_KEY = 'kw.crash.pending';
const MAX_PER_LOAD = 5;
const MIN_GAP_MS = 3000;

function originOf(u: string | undefined): string | null {
  try { return u ? new URL(u, location.origin).origin : null; } catch { return null; }
}

function context(): ScrubContext {
  const api = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  return { appOrigins: [location.origin], apiOrigins: api && api !== location.origin ? [api] : [], route: routePattern };
}

function platform(): CrashPlatform {
  const n = nativePlatform();
  if (n) return n;
  try { if (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true) return 'pwa'; } catch { /* old browser */ }
  return 'web';
}

// The Android/iOS app's own version (KithwallShell.info), read once when reporting starts.
let appInfo: { version: string; build: string } = { version: '', build: '' };

function webBuild(): string {
  return COMMIT_SHA ? COMMIT_SHA.slice(0, 12) : (process.env.NEXT_PUBLIC_BUILD_ID ?? '').slice(0, 40);
}

interface Extra { componentStack?: string | null; pathname?: string }

/** The report for an error, or null for noise (network failures, aborted requests, extension script errors). */
export function makeReport(kind: CrashKind, err: unknown, extra: Extra = {}): CrashReport | null {
  const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const isObj = !!e && typeof e === 'object';
  const name = isObj && typeof e.name === 'string' ? e.name : 'Error';
  // A thrown string is treated as a message; any other non-Error value says nothing we may send.
  const message = isObj ? (typeof e.message === 'string' ? e.message : '') : typeof err === 'string' ? err : '';
  const stack = isObj && typeof e.stack === 'string' ? e.stack : '';
  if (kind !== 'native' && isNoise(name, message)) return null;
  const report = buildReport({
    kind, name, stack, componentStack: extra.componentStack ?? '',
    // The Android app's own exceptions quote file paths and values in their messages: never sent.
    message: kind === 'native' ? '' : message,
    app: { web: webBuild(), ...appInfo }, platform: platform(), userAgent: navigator.userAgent,
    pathname: extra.pathname ?? location.pathname,
    locale: (document.documentElement.lang || 'en').toLowerCase().split('-')[0] ?? 'en',
  }, crypto.randomUUID(), context());
  return report.stack || report.message ? report : null;
}

/** The exact bytes that are sent (and shown under "See what gets sent"). */
export const serialise = (r: CrashReport): string => JSON.stringify(r);

async function post(body: string): Promise<boolean> {
  if (body.length > REPORT_MAX_BYTES) return true; // can't happen with the scrubber's caps; never retried
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', body, headers: { 'content-type': 'application/json' },
      // No cookies, no Authorization header, no referrer: the server gets the report and nothing else.
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', keepalive: true,
    });
    // Refused (rate limit, bad shape) is final; only a failed connection is worth another try.
    return res.status < 500;
  } catch { return false; }
}

let sentThisLoad = 0;
let lastAt = 0;
const seen = new Set<string>();

function store(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

/** Report an error if the person turned crash reports on. Never throws. */
export function captureCrash(kind: CrashKind, err: unknown, extra: Extra = {}): void {
  try {
    if (!crashReportsOn()) return;
    const now = Date.now();
    if (sentThisLoad >= MAX_PER_LOAD || now - lastAt < MIN_GAP_MS) return;
    const report = makeReport(kind, err, extra);
    if (!report) return;
    // The same failure repeating (a render loop, a timer) is reported once per page load.
    const sig = `${report.name}|${report.stack.split('\n')[0] ?? report.message}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    sentThisLoad++;
    lastAt = now;
    const body = serialise(report);
    store(LAST_KEY, body);
    void post(body).then((ok) => { if (!ok) store(PENDING_KEY, body); });
  } catch { /* reporting must never break the page */ }
}

/** The last report this device sent, as transmitted; null when there is none. */
export function lastReport(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

/** What a report from this device would look like right now, built the same way from a made-up error. */
export function exampleReport(): string {
  const sample = new TypeError("Cannot read properties of undefined (reading 'example')");
  const r = makeReport('error', sample);
  return r ? serialise(r) : '{}';
}

async function sendPending(): Promise<void> {
  let body: string | null = null;
  try { body = localStorage.getItem(PENDING_KEY); } catch { /* storage blocked */ }
  if (!body) return;
  if (await post(body)) store(PENDING_KEY, null);
}

/** Android app: a crash of the app itself, recorded natively and handed over on the next start. */
async function sendNativeCrash(): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  const shell = await nativePlugin('KithwallShell');
  if (typeof shell.pendingCrash !== 'function') return; // an app from before crash reports
  const c = await shell.pendingCrash();
  if (!c?.name && !c?.stack) return;
  const r = makeReport('native', { name: c.name, stack: c.stack }, { pathname: UNKNOWN_ROUTE });
  if (r) {
    // It crashed in the build that recorded it, which may be older than the one running now.
    if (typeof c.version === 'string') r.app.version = /^[A-Za-z0-9._+-]{0,40}$/.test(c.version) ? c.version : '';
    if (typeof c.build === 'string') r.app.build = /^[A-Za-z0-9._+-]{0,40}$/.test(c.build) ? c.build : '';
    const body = serialise(r);
    store(LAST_KEY, body);
    if (!(await post(body))) store(PENDING_KEY, body);
  }
  await shell.clearCrash?.();
}

/** Tell the Android app whether it may write a crash down at all (it records nothing while this is off). */
export async function syncNativeCrashSetting(on: boolean): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  try { await (await nativePlugin('KithwallShell')).setCrashReports?.({ enabled: on }); } catch { /* an older app */ }
}

/** Start catching errors (the setting is on). Returns the stop function. */
export function startCrashReporting(): () => void {
  const onError = (e: ErrorEvent) => captureCrash('error', e.error ?? { name: 'Error', message: e.message });
  const onRejection = (e: PromiseRejectionEvent) => captureCrash('rejection', e.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  void (async () => {
    if (isNative()) {
      try {
        const info = await (await nativePlugin('KithwallShell')).info();
        appInfo = { version: String(info.version ?? '').slice(0, 40), build: String(info.build ?? '').slice(0, 40) };
      } catch { /* stays empty */ }
      await syncNativeCrashSetting(true);
    }
    await sendPending();
    await sendNativeCrash();
  })().catch(() => undefined);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
