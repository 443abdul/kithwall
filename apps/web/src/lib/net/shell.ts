'use client';
// The offline app shell from the page's side (public/sw.js does the caching; docs/v2/08-censorship.md §5).
// A signed-in, online page asks the service worker to keep this build's shell: the static /offline entry
// point and static files only, never user data. Signing out deletes it; the panic wipe deletes every cache.
// In the Kithwall app the native side is told whether the shell is there, so its bundled offline page can
// offer "Open Kit Drop" (apps/mobile/scripts/prepare.mjs).
import { isNative, nativePlugin } from '../native';

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
const SHELL_PREFIX = 'kw-shell-';

/** The service worker for this build: /sw.js?v=<build> (+ app=1 inside the app, dev=1 under `next dev`). */
export function serviceWorkerUrl(): string {
  const q = new URLSearchParams({ v: BUILD });
  if (isNative()) q.set('app', '1');
  if (process.env.NODE_ENV === 'development') q.set('dev', '1');
  return `/sw.js?${q.toString()}`;
}

/** Ask the active service worker to keep this build's shell. Resolves with whether it is stored. */
export async function keepOfflineShell(reg: ServiceWorkerRegistration): Promise<boolean> {
  const sw = reg.active ?? (await navigator.serviceWorker.ready).active;
  if (!sw) return false;
  const ready = await new Promise<boolean>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => { ch.port1.close(); resolve(false); }, 120_000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); ch.port1.close(); resolve((e.data as { ready?: unknown } | null)?.ready === true); };
    sw.postMessage({ type: 'kw:shell-enable' }, [ch.port2]);
  });
  await tellApp(ready);
  return ready;
}

/** Signing out: delete every build's shell, so nothing stays to open offline. */
export async function dropOfflineShell(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (k.startsWith(SHELL_PREFIX)) await caches.delete(k);
  } catch { /* no Cache Storage */ }
  await tellApp(false);
}

async function tellApp(ready: boolean): Promise<void> {
  if (!isNative()) return;
  try { await (await nativePlugin('KithwallShell')).setOfflineShell({ ready }); } catch { /* an older app */ }
}
