'use client';
// App shell helpers (docs/v2/05-native.md §6): screen protection, screenshot notices, leaving the app.
import { isNative, nativePlugin } from './index';
import type { ShellInfo } from './plugins';

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