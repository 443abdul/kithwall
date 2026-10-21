'use client';
// The native-app bridge (docs/v2/05-native.md §1). The Android and iOS apps load this same web app from
// the server; Capacitor injects `window.Capacitor` before any page script runs. In a normal browser
// none of this is present and every helper here is a cheap synchronous "no".
//
// The Capacitor JS runtime and the plugin proxies are only imported (dynamically, in their own chunk)
// when running inside the app, so the browser bundle doesn't grow.
import type { KithwallPasskeyPlugin, KithwallPushPlugin, KithwallSecurePlugin, KithwallShellPlugin } from './plugins';

interface CapacitorGlobal { isNativePlatform?: () => boolean; getPlatform?: () => string }

function cap(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/** Running inside the Kithwall Android or iOS app? */
export function isNative(): boolean {
  try { return !!cap()?.isNativePlatform?.(); } catch { return false; }
}

export type NativePlatform = 'android' | 'ios';
export function nativePlatform(): NativePlatform | null {
  if (!isNative()) return null;
  const p = cap()?.getPlatform?.();
  return p === 'android' || p === 'ios' ? p : null;
}

interface PluginMap {
  KithwallPasskey: KithwallPasskeyPlugin;
  KithwallSecure: KithwallSecurePlugin;
  KithwallShell: KithwallShellPlugin;
  KithwallPush: KithwallPushPlugin;
}

const cache = new Map<keyof PluginMap, unknown>();
let core: Promise<typeof import('@capacitor/core')> | null = null;

/** A native plugin proxy. Only call when isNative(). */
export async function nativePlugin<K extends keyof PluginMap>(name: K): Promise<PluginMap[K]> {
  if (!isNative()) throw new Error('not running in the Kithwall app');
  const hit = cache.get(name);
  if (hit) return hit as PluginMap[K];
  core ??= import('@capacitor/core');
  const { registerPlugin } = await core;
  const p = registerPlugin<PluginMap[K]>(name);
  cache.set(name, p);
  return p;
}

/** The error code a plugin call rejected with ('cancelled', 'unavailable', …), if any. */
export function nativeErrorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
}
