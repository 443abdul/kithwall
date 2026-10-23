'use client';
// The Android app's network plugin (apps/mobile/android/.../KithwallNetPlugin.java): "Use Tor (Orbot)"
// through androidx.webkit ProxyController, and the origins the app may fail over to when its usual
// address is blocked. Not present in browsers or on iOS: every helper is a cheap "no" there.
import { isNative, nativePlatform, notThenable } from '@/lib/native';

export interface NetNativeStatus {
  /** WebView supports a proxy override (androidx.webkit PROXY_OVERRIDE). */
  proxySupported: boolean;
  orbotInstalled: boolean;
  /** Orbot's local HTTP proxy (127.0.0.1:8118) accepts connections. */
  orbotRunning: boolean;
  /** "Use Tor" is on (the WebView goes through Orbot). */
  tor: boolean;
  /** The origin the app is showing now, and every origin it may switch to (built in + learned). */
  origin: string;
  origins: string[];
}

interface KithwallNetPlugin {
  status(): Promise<NetNativeStatus>;
  /** Turns the WebView proxy on/off; rejects with 'orbot_missing' / 'unsupported'. Reloads the page. */
  setTor(opts: { enabled: boolean }): Promise<NetNativeStatus>;
  /** Opens Orbot (asking it to start), or its store page when it isn't installed. */
  openOrbot(): Promise<void>;
  /** Mirror origins from a verified signed list (https only; the built-in list always comes first). */
  setLearnedOrigins(opts: { origins: string[] }): Promise<void>;
}

let plugin: Promise<KithwallNetPlugin> | null = null;

/** Running in the Android app (where the plugin exists)? */
export function hasNativeNet(): boolean {
  return isNative() && nativePlatform() === 'android';
}

async function net(): Promise<KithwallNetPlugin> {
  plugin ??= import('@capacitor/core').then(({ registerPlugin }) => notThenable(registerPlugin<KithwallNetPlugin>('KithwallNet')));
  return plugin;
}

export async function nativeNetStatus(): Promise<NetNativeStatus | null> {
  if (!hasNativeNet()) return null;
  try { return await (await net()).status(); } catch { return null; }
}

export async function setNativeTor(enabled: boolean): Promise<NetNativeStatus> {
  return (await net()).setTor({ enabled });
}

export async function openOrbot(): Promise<void> {
  await (await net()).openOrbot();
}

export async function setLearnedOrigins(origins: string[]): Promise<void> {
  if (!hasNativeNet()) return;
  try { await (await net()).setLearnedOrigins({ origins: origins.filter((o) => /^https:\/\//.test(o)) }); } catch { /* older app build */ }
}
