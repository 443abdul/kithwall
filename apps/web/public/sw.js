/* Kithwall service worker — Web Push, and the offline app shell.
 *
 * - Offline app shell (Kit Drop, docs/v2/08-censorship.md §5, privacy review there): once a signed-in page
 *   asks for it, this keeps ONE cache per build ("kw-shell-<build>", the build comes from the registration
 *   URL /sw.js?v=<build>) holding only static, non-personal files: the /offline entry point (fetched
 *   without cookies; the same document for everyone), the /_next/static files it and the app use, and
 *   icons / theme.js / the manifest. Never an API response, a Supabase request, user data or any other
 *   page's HTML. Navigations always go to the network; only when the network can't be reached does the
 *   browser get the shell (/offline), which opens the account from what the app keeps on the device.
 *   Old builds' caches are deleted on activation; the app deletes this one on sign-out, the panic wipe
 *   deletes everything.
 * - The cached shell is served with a FRESH CSP nonce on every load: the page's nonce attributes and the
 *   CSP header are rewritten together here, so a stored nonce is never reused (src/proxy.ts mints one per
 *   request the same way).
 * - In the Kithwall app (/sw.js?…&app=1) navigations are never answered here: a failed page load must reach
 *   the app (bundled offline page, mirror failover); that offline page links to /offline instead.
 * - Push payloads are "who + what" ("dan sent you a message"), encrypted end to end between our
 *   server and this browser (RFC 8291); the push service in between can't read them.
 * - Clicking a notification focuses an open Kithwall tab and asks it to navigate in-app (keeping
 *   its unlocked keys in memory), or opens a new window.
 * - Hidden chats (Safety centre, docs/v2/03-safety.md): the app keeps salted SHA-256 hashes of the
 *   hidden conversation ids in IndexedDB ("kithwall-sw"); pushes for those chats are shown as a
 *   generic "new activity" notice, without the sender or a link into the chat.
 * - Calls: "Dan is calling" opens /messages/<chat>?call=<id>; the app then asks the caller's device whether
 *   it is still ringing. Call pushes expire after 45 s and stay up until tapped or dismissed. A call from a
 *   hidden chat gets the same generic notice as any other hidden-chat push.
 */
'use strict';

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';

// ---------------------------------------------------------------------------------------
// Offline app shell
const PARAMS = new URL(self.location.href).searchParams;
const BUILD = (PARAMS.get('v') || 'dev').replace(/[^\w.-]/g, '').slice(0, 80) || 'dev';
const IN_APP = PARAMS.get('app') === '1';
// `next dev` serves changing files under stable names: never cache-first there.
const DEV = PARAMS.get('dev') === '1';
const SHELL_PREFIX = 'kw-shell-';
const SHELL_CACHE = SHELL_PREFIX + BUILD;
const SHELL_PATH = '/offline';
/** Non-hashed static files (network first, cached copy when offline). */
const PLAIN_FILES = ['/theme.js', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg', '/icons/icon-192.png', '/icons/badge-72.png', '/icons/apple-touch-icon.png'];
/** Headers kept with the shell document. */
const SHELL_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'strict-transport-security'];
const NONCE_RE = /'nonce-([A-Za-z0-9+/=]+)'/;

const isHashedStatic = (url) => url.pathname.indexOf('/_next/static/') === 0;
const isPlainStatic = (url) => PLAIN_FILES.indexOf(url.pathname) >= 0;

/** Is this build's shell stored? (The document is stored last; a cache without it doesn't count.) */
const hasShell = () => caches.match(SHELL_PATH, { cacheName: SHELL_CACHE }).then((r) => !!r, () => false);

/** Did this device keep a shell for any build (so a new build should fetch its own)? */
async function shellEnabled() {
  try {
    for (const k of await caches.keys()) {
      if (k.indexOf(SHELL_PREFIX) === 0 && await caches.match(SHELL_PATH, { cacheName: k })) return true;
    }
  } catch { /* no Cache Storage */ }
  return false;
}

/**
 * Fetch this build's shell: /offline without cookies (a static page, the same for everyone), then every
 * /_next/static file it references, then the plain static files. The document is stored last, so a stored
 * shell always has its files.
 */
async function fillShell() {
  const res = await fetch(SHELL_PATH, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const csp = res.headers.get('content-security-policy') || '';
  if (!res.ok || res.type !== 'basic' || (res.headers.get('content-type') || '').indexOf('text/html') !== 0 || !NONCE_RE.test(csp)) {
    throw new Error('shell unavailable');
  }
  const html = await res.text();
  const files = new Set(PLAIN_FILES);
  const re = /\/_next\/static\/[^"'\s\\<>()]+/g;
  for (let m = re.exec(html); m; m = re.exec(html)) files.add(m[0]);
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all([...files].map(async (u) => {
    try {
      if (await cache.match(u)) return;
      const r = await fetch(u, { credentials: 'omit' });
      if (r.ok && r.type === 'basic') await cache.put(u, r);
    } catch { /* one missing file must not stop the rest */ }
  }));
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  for (const h of SHELL_HEADERS) { const v = res.headers.get(h); if (v) headers.set(h, v); }
  await cache.put(SHELL_PATH, new Response(html, { status: 200, headers }));
}

async function ensureShell() {
  try {
    if (await hasShell()) return true;
    await fillShell();
    return true;
  } catch {
    return false;
  }
}

function freshNonce() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/** The stored shell with a new nonce in both the CSP header and the document, or null. */
async function shellResponse() {
  const res = await caches.match(SHELL_PATH, { cacheName: SHELL_CACHE });
  if (!res) return null;
  const csp = res.headers.get('content-security-policy') || '';
  const m = NONCE_RE.exec(csp);
  if (!m) return null;
  const old = m[1];
  const nonce = freshNonce();
  const html = (await res.text()).split(old).join(nonce);
  const headers = new Headers(res.headers);
  headers.set('content-security-policy', csp.split(old).join(nonce));
  headers.set('cache-control', 'no-store');
  return new Response(html, { status: 200, headers });
}

/** /offline itself: the stored shell first (it must open fast with no connection), else the network. */
async function openShell(event) {
  if (DEV) {
    try { return await fetch(event.request); } catch (e) { const c = await shellResponse().catch(() => null); if (c) return c; throw e; }
  }
  const cached = await shellResponse().catch(() => null);
  return cached || fetch(event.request);
}

/** Any other page: exactly the network's answer; only when there is none, the shell. */
async function navigate(event) {
  try {
    const pre = await event.preloadResponse;
    if (pre) return pre;
    return await fetch(event.request);
  } catch (e) {
    if (!(await hasShell())) throw e;
    const url = new URL(event.request.url);
    return Response.redirect(SHELL_PATH + '?from=' + encodeURIComponent(url.pathname + url.search), 302);
  }
}

/** Static files: content-hashed ones from the cache first, plain ones from the network first. */
async function staticFile(request, url) {
  const cached = () => caches.match(request, { cacheName: SHELL_CACHE });
  if (isHashedStatic(url) && !DEV) {
    const hit = await cached();
    if (hit) return hit;
  }
  try {
    const res = await fetch(request);
    // Checked again right before storing: signing out deletes the shell, and nothing may bring it back.
    if (res.ok && res.type === 'basic' && await hasShell()) {
      const copy = res.clone();
      await caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => undefined);
    }
    return res;
  } catch (e) {
    const hit = await cached();
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    if (url.pathname === SHELL_PATH) event.respondWith(openShell(event));
    else if (!IN_APP) event.respondWith(navigate(event));
    return;
  }
  // Only while the shell is kept (a signed-in device asked for it): static files, nothing else.
  if (isHashedStatic(url) || isPlainStatic(url)) {
    event.respondWith(hasShell().then((on) => (on ? staticFile(req, url) : fetch(req))));
  }
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || d.type !== 'kw:shell-enable') return;
  const port = event.ports && event.ports[0];
  event.waitUntil(ensureShell().then((ready) => { if (port) port.postMessage({ type: 'kw:shell', ready, build: BUILD }); }));
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // A device that kept the previous build's shell gets this build's before it takes over.
    if (await shellEnabled()) await ensureShell();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      for (const k of await caches.keys()) if (k.indexOf(SHELL_PREFIX) === 0 && k !== SHELL_CACHE) await caches.delete(k);
    } catch { /* nothing to clean */ }
    // Pages load as fast as without a service worker: the request starts while this worker starts up.
    if (!IN_APP && self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
    if (IN_APP && self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => undefined);
    await self.clients.claim();
  })());
});

/** Kithwall 2 routes for links in pushes queued by older servers (v1 paths). */
function v2Path(p) {
  if (p === '/notifications' || p.indexOf('/notifications?') === 0) return '/activity';
  if (p === '/requests') return '/activity?tab=requests';
  if (p === '/messages/inbox') return '/messages';
  if (p.indexOf('/settings/security') === 0) return '/you/settings/security' + p.slice('/settings/security'.length);
  if (p.indexOf('/settings/account') === 0) return '/you/settings/notifications' + p.slice('/settings/account'.length);
  if (p.indexOf('/groups/') === 0) return '/circles/' + p.slice('/groups/'.length);
  if (p.indexOf('/circles/events/') === 0) return p.slice('/circles'.length);
  if (p.indexOf('/circles/notes/') === 0) return p.slice('/circles'.length);
  if (p.indexOf('/photos/') === 0) return '/albums';
  return p;
}

/** Only same-origin paths may be opened from a notification. */
function safePath(u) {
  try {
    const url = new URL(typeof u === 'string' ? u : '/activity', self.location.origin);
    if (url.origin !== self.location.origin) return '/activity';
    return v2Path(url.pathname + url.search + url.hash);
  } catch (_) {
    return '/activity';
  }
}

function setBadge(n) {
  try {
    const nav = self.navigator;
    if (!nav || typeof nav.setAppBadge !== 'function') return Promise.resolve();
    return (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => undefined);
  } catch (_) {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------
// Hidden chats (written by apps/web/src/lib/safety/swmirror.ts; same hash: SHA-256("<salt>:<id>")).
function readHidden() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('kithwall-sw', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const get = db.transaction('kv', 'readonly').objectStore('kv').get('hidden');
          get.onsuccess = () => { db.close(); resolve(get.result || null); };
          get.onerror = () => { db.close(); resolve(null); };
        } catch (_) { db.close(); resolve(null); }
      };
    } catch (_) { resolve(null); }
  });
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function isHiddenConversation(path, tag) {
  const m = /^\/messages\/([0-9a-f-]{36})/i.exec(path) || /^conv:([0-9a-f-]{36})$/i.exec(tag || '');
  if (!m) return false;
  const rec = await readHidden();
  if (!rec || typeof rec.salt !== 'string' || !Array.isArray(rec.hashes) || !rec.hashes.length) return false;
  try {
    const h = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rec.salt + ':' + m[1].toLowerCase())));
    return rec.hashes.indexOf(h) >= 0;
  } catch (_) {
    return false;
  }
}

async function handlePush(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 60) : 'Kithwall';
  const body = typeof data.body === 'string' && data.body ? data.body.slice(0, 200) : 'You have new activity on Kithwall.';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag.slice(0, 120) : 'kithwall';
  const path = safePath(data.url);
  const badge = Number.isFinite(data.badge) ? Math.max(0, Math.min(999, data.badge | 0)) : null;

  // A hidden chat: say only that something happened (no sender, no preview, no link into the chat).
  if (await isHiddenConversation(path, data.tag)) {
    if (badge !== null) await setBadge(badge);
    await self.registration.showNotification('Kithwall', {
      body: 'You have new activity on Kithwall.', tag: 'kithwall', icon: ICON, badge: BADGE,
      timestamp: Date.now(), data: { url: '/activity', kind: 'notification' },
    });
    return;
  }

  if (badge !== null) await setBadge(badge);

  // Someone is already looking at this conversation: don't interrupt them.
  if (data.kind === 'message') {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const watching = wins.some((c) => {
      try { return c.focused && c.visibilityState === 'visible' && new URL(c.url).pathname === path; } catch (_) { return false; }
    });
    if (watching) return;
  }

  // A call (docs/v2/04-calls.md §6): an open, visible Kithwall tab is already ringing in the app.
  if (data.kind === 'call') {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return;
  }

  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    lang: 'en-US',
    timestamp: Date.now(),
    ...(data.kind === 'call' ? { requireInteraction: true, vibrate: [300, 150, 300, 150, 300] } : {}),
    data: { url: path, kind: data.kind || 'notification' },
  });
}

self.addEventListener('push', (event) => { event.waitUntil(handlePush(event)); });

async function openPath(path) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOrigin = wins.filter((c) => { try { return new URL(c.url).origin === self.location.origin; } catch (_) { return false; } });
  const target = sameOrigin.find((c) => c.focused) || sameOrigin.find((c) => c.visibilityState === 'visible') || sameOrigin[0];
  if (target) {
    // In-app navigation keeps the tab's unlocked keys; the page listens for this message.
    target.postMessage({ type: 'kw:navigate', url: path });
    try { await target.focus(); } catch (_) { /* focus can be refused; the message was still delivered */ }
    return;
  }
  await self.clients.openWindow(path);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(openPath(path));
});

function b64u(buf) {
  if (!buf) return null;
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The browser rotated (or expired) our subscription. Re-subscribe with the same server key and tell
// the server, proving ownership of the old one with its endpoint + auth secret.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription || null;
    let sub = event.newSubscription || null;
    if (!sub) {
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    if (!old) return; // can't prove ownership; the app re-registers next time it's opened
    const oldAuth = b64u(old.getKey && old.getKey('auth'));
    const j = sub.toJSON();
    await fetch('/api/push/resubscribe', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old: { endpoint: old.endpoint, auth: oldAuth }, sub: { endpoint: j.endpoint, keys: j.keys } }),
    }).catch(() => undefined);
  })());
});
