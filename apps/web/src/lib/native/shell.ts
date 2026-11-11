'use client';
// App shell helpers (docs/v2/05-native.md §6): screen protection, screenshot notices, leaving the app.
import { isNative, nativePlugin } from './index';
import type { AppIconId, ShellInfo } from './plugins';

export async function shellInfo(): Promise<ShellInfo | null> {
  if (!isNative()) return null;
  try { return await (await nativePlugin('KithwallShell')).info(); } catch { return null; }
}

/** "Block screenshots and hide app preview" (device setting, kept by the app itself). */
export async function getSecureScreen(): Promise<boolean> {
  if (!isNative()) return false;
  try { return (await (await nativePlugin('KithwallShell')).getSecureScreen()).enabled; } catch { return false; }
}
export async function setSecureScreen(enabled: boolean): Promise<void> {
  await (await nativePlugin('KithwallShell')).setSecureScreen({ enabled });
}

/**
 * Disguised app icon (Android app 2.5.0+, docs/v2/03-safety.md §13): which launcher entry is switched on,
 * or null where the app can't change it (iOS, older Android apps, a browser).
 */
export async function getAppIcon(): Promise<{ icon: AppIconId; options: AppIconId[] } | null> {
  if (!isNative()) return null;
  try {
    const shell = await nativePlugin('KithwallShell');
    // A method the installed app doesn't know rejects ("not implemented"): treated as "can't".
    const r = await shell.getAppIcon?.();
    return r && typeof r.icon === 'string' && Array.isArray(r.options) ? r : null;
  } catch { return null; }
}
/** Switch the launcher entry. The app answers first and switches a moment later (it usually closes then). */
export async function setAppIcon(icon: AppIconId): Promise<void> {
  const shell = await nativePlugin('KithwallShell');
  if (!shell.setAppIcon) throw new Error('unsupported');
  await shell.setAppIcon({ icon });
}

/** Screenshot / recording notices. A local notice only: the other people in a chat are never told. */
export async function onScreenCapture(fn: (kind: 'screenshot' | 'recording') => void): Promise<() => void> {
  if (!isNative()) return () => undefined;
  const h = await (await nativePlugin('KithwallShell')).addListener('screenshot', (e) => fn(e.kind === 'recording' ? 'recording' : 'screenshot'));
  return () => { void h.remove(); };
}

/** Quick exit in the app: leave to the neutral site in the system browser (and on Android, drop from recents). */
export async function exitApp(url: string): Promise<void> {
  await (await nativePlugin('KithwallShell')).exit({ url });
}


/** Panic wipe: the WebView's own cookies, caches and storage (lib/safety/wipe.ts). */
export async function clearWebData(): Promise<void> {
  if (!isNative()) return;
  await (await nativePlugin('KithwallShell')).clearWebData();
}