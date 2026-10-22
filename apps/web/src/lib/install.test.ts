// Installing as an app (lib/install.ts): platform detection, returning-visitor eligibility, snooze and
// "don't ask again", and the pre-hydration capture in public/theme.js. Run: npx vitest run src/lib/install
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  INSTALL_KEYS, RETURNING_AFTER_MS, SNOOZE_MS, detectPlatform, groupOf, hasInstructions, isReturning,
  neverNudge, noteVisit, nudgeEligible, readVisits, snoozeNudge, type InstallPlatform, type Visits,
} from './install';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  androidEdge: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
};

describe('detectPlatform', () => {
  const cases: [string, Parameters<typeof detectPlatform>[0], InstallPlatform][] = [
    ['iPhone Safari', { ua: UA.iphoneSafari, platform: 'iPhone', maxTouchPoints: 5 }, 'ios-safari'],
    ['iPhone Chrome', { ua: UA.iphoneChrome, platform: 'iPhone', maxTouchPoints: 5 }, 'ios-other'],
    ['iPhone Firefox', { ua: UA.iphoneFirefox, platform: 'iPhone', maxTouchPoints: 5 }, 'ios-other'],
    ['Instagram in-app browser', { ua: UA.iphoneInstagram, platform: 'iPhone', maxTouchPoints: 5 }, 'ios-other'],
    ['iPad (desktop-class Safari)', { ua: UA.ipadDesktopMode, platform: 'MacIntel', maxTouchPoints: 5 }, 'ios-safari'],
    ['Mac Safari', { ua: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, 'desktop-safari'],
    ['Mac Chrome', { ua: UA.macChrome, platform: 'MacIntel' }, 'desktop-chromium'],
    ['Windows Edge', { ua: UA.winEdge, platform: 'Win32' }, 'desktop-chromium'],
    ['Windows Firefox', { ua: UA.winFirefox, platform: 'Win32' }, 'desktop-firefox'],
    ['Linux Chrome', { ua: UA.linuxChrome, platform: 'Linux x86_64' }, 'desktop-chromium'],
    ['Android Chrome', { ua: UA.androidChrome, platform: 'Linux armv81', maxTouchPoints: 5 }, 'android-chromium'],
    ['Android Edge', { ua: UA.androidEdge, maxTouchPoints: 5 }, 'android-chromium'],
    ['Samsung Internet', { ua: UA.androidSamsung, maxTouchPoints: 5 }, 'android-samsung'],
    ['Android Firefox', { ua: UA.androidFirefox, maxTouchPoints: 5 }, 'android-firefox'],
    ['empty', { ua: '' }, 'unknown'],
  ];
  for (const [name, input, want] of cases) it(name, () => { expect(detectPlatform(input)).toBe(want); });

  it('groups platforms and knows which have instructions', () => {
    expect(groupOf('ios-other')).toBe('ios');
    expect(groupOf('android-samsung')).toBe('android');
    expect(groupOf('desktop-safari')).toBe('desktop');
    expect(groupOf('unknown')).toBeNull();
    expect(hasInstructions('desktop-firefox')).toBe(false);
    expect(hasInstructions('unknown')).toBe(false);
    expect(hasInstructions('ios-safari')).toBe(true);
  });
});

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

const T0 = Date.UTC(2026, 9, 1);
const HOUR = 60 * 60_000;
const base = (v: Partial<Visits> = {}): Visits => ({ firstSeen: T0, sessions: 1, snoozedUntil: 0, never: false, installedBefore: false, ...v });
const ok = { native: false, installed: false, canInstall: false, platform: 'ios-safari' as InstallPlatform };

describe('visits', () => {
  it('counts each browser session once and remembers the first visit', () => {
    const local = mem();
    let session = mem();
    expect(noteVisit(local, session, T0)).toMatchObject({ firstSeen: T0, sessions: 1 });
    expect(noteVisit(local, session, T0 + HOUR)).toMatchObject({ firstSeen: T0, sessions: 1 }); // same session
    session = mem(); // the browser was closed and opened again
    expect(noteVisit(local, session, T0 + 2 * HOUR)).toMatchObject({ firstSeen: T0, sessions: 2 });
    expect(Object.keys(local.dump()).every((k) => k.startsWith('kw.install.'))).toBe(true);
  });
  it('survives blocked storage', () => {
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(noteVisit(boom, boom, T0)).toEqual({ firstSeen: 0, sessions: 0, snoozedUntil: 0, never: false, installedBefore: false });
    expect(noteVisit(null, null, T0).sessions).toBe(0);
  });
});

describe('nudge eligibility', () => {
  it('never on a first visit', () => {
    expect(isReturning(base(), T0 + HOUR)).toBe(false);
    expect(nudgeEligible({ ...ok, visits: base(), now: T0 + HOUR })).toBe(false);
    expect(nudgeEligible({ ...ok, visits: base({ firstSeen: 0, sessions: 0 }), now: T0 })).toBe(false);
  });
  it('from the second session, or three days after the first visit', () => {
    expect(nudgeEligible({ ...ok, visits: base({ sessions: 2 }), now: T0 + HOUR })).toBe(true);
    expect(nudgeEligible({ ...ok, visits: base(), now: T0 + RETURNING_AFTER_MS - 1 })).toBe(false);
    expect(nudgeEligible({ ...ok, visits: base(), now: T0 + RETURNING_AFTER_MS })).toBe(true);
  });
  it('not in the native app, when installed, or with nothing to offer', () => {
    const visits = base({ sessions: 3 });
    expect(nudgeEligible({ ...ok, visits, now: T0, native: true })).toBe(false);
    expect(nudgeEligible({ ...ok, visits, now: T0, installed: true })).toBe(false);
    expect(nudgeEligible({ ...ok, visits: { ...visits, installedBefore: true }, now: T0 })).toBe(false);
    expect(nudgeEligible({ ...ok, visits, now: T0, platform: 'desktop-firefox' })).toBe(false);
    expect(nudgeEligible({ ...ok, visits, now: T0, platform: 'unknown' })).toBe(false);
    expect(nudgeEligible({ ...ok, visits, now: T0, platform: 'unknown', canInstall: true })).toBe(true);
  });
  it('"Not now" snoozes for 30 days; "Don\'t ask again" is final', () => {
    const local = mem({ [INSTALL_KEYS.firstSeen]: String(T0), [INSTALL_KEYS.sessions]: '5' });
    const now = T0 + 10 * 24 * HOUR;
    expect(nudgeEligible({ ...ok, visits: readVisits(local), now })).toBe(true);
    snoozeNudge(local, now);
    expect(nudgeEligible({ ...ok, visits: readVisits(local), now: now + SNOOZE_MS - 1 })).toBe(false);
    expect(nudgeEligible({ ...ok, visits: readVisits(local), now: now + SNOOZE_MS })).toBe(true);
    neverNudge(local);
    expect(nudgeEligible({ ...ok, visits: readVisits(local), now: now + 10 * SNOOZE_MS })).toBe(false);
    expect(local.dump()[INSTALL_KEYS.never]).toBe('1');
  });
});

describe('public/theme.js install capture', () => {
  const src = readFileSync(join(__dirname, '../../public/theme.js'), 'utf8');
  function boot(capacitor?: unknown) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const dispatched: string[] = [];
    const window: Record<string, unknown> = {
      localStorage: mem(), matchMedia: () => ({ matches: false }),
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      dispatchEvent: (e: { type: string }) => { dispatched.push(e.type); return true; },
      Capacitor: capacitor,
    };
    const document = { documentElement: { setAttribute: () => undefined }, querySelector: () => null, addEventListener: () => undefined };
    class Event { constructor(public type: string) {} }
    runInNewContext(src, { window, document, navigator: { languages: ['en'], language: 'en' }, location: { pathname: '/' }, Event });
    return { window, handlers, dispatched };
  }
  it('parks beforeinstallprompt before the app hydrates and suppresses the mini-infobar', () => {
    const { window, handlers, dispatched } = boot();
    let prevented = false;
    const ev = { preventDefault: () => { prevented = true; } };
    handlers.beforeinstallprompt!(ev);
    expect(prevented).toBe(true);
    expect(window.__kwInstall).toBe(ev);
    expect(dispatched).toEqual(['kw:install']);
    handlers.appinstalled!({});
    expect(window.__kwInstall).toBeNull();
    expect(window.__kwInstalled).toBe(true);
  });
  it('does nothing inside the Kithwall app', () => {
    const { handlers } = boot({ isNativePlatform: () => true });
    expect(handlers.beforeinstallprompt).toBeUndefined();
  });
});
