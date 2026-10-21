'use client';
// Quick exit (docs/v2/03-safety.md §4): blank the screen at once, wipe (or lock) this device, and
// replace the page with a neutral site. Opt-in; triggered by the shield button, a triple tap on the
// Kithwall logo or Esc pressed three times (components/safety/SafetyRuntime).
import { lock } from '../keys/session';
import { getExitPrefs } from './applock';
import { wipeThisDevice } from './wipe';
import { isNative } from '../native';

let exiting = false;

export function quickExit(): void {
  if (exiting) return;
  exiting = true;
  const p = getExitPrefs();
  document.documentElement.classList.add('kw-exiting');
  document.title = '…';
  // In the app, other sites never load inside Kithwall: hand the neutral site to the system browser
  // (Android also removes Kithwall from the recent-apps list), then leave the app on a blank page.
  const go = isNative()
    ? () => { void import('../native/shell').then((m) => m.exitApp(p.site)).catch(() => undefined).finally(() => { try { location.replace('/'); } catch { /* ignore */ } }); }
    : () => { try { location.replace(p.site); } catch { location.href = p.site; } };
  const deadline = setTimeout(go, 2500);
  const work = p.action === 'wipe' ? wipeThisDevice() : lock();
  void work.catch(() => undefined).finally(() => { clearTimeout(deadline); go(); });
}
