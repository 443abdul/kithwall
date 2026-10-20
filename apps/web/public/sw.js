/* Kithwall service worker — Web Push only.
 *
 * - No fetch handler and no caches: nothing a user sees or sends is ever stored here. Every request
 *   goes straight to the network exactly as without a service worker.
 * - Push payloads are "who + what" ("dan sent you a message"), encrypted end to end between our
 *   server and this browser (RFC 8291); the push service in between can't read them.
 * - Clicking a notification focuses an open Kithwall tab and asks it to navigate in-app (keeping
 *   its unlocked keys in memory), or opens a new window.
 * - Hidden chats (Safety centre, docs/v2/03-safety.md): the app keeps salted SHA-256 hashes of the
 *   hidden conversation ids in IndexedDB ("kithwall-sw"); pushes for those chats are shown as a
 *   generic "new activity" notice, without the sender or a link into the chat.
 */
'use strict';

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-72.png';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/** Kithwall 2 routes for links in pushes queued by older servers (v1 paths). */
function v2Path(p) {
  if (p === '/notifications' || p.indexOf('/notifications?') === 0) return '/activity';
  if (p === '/requests' || p === '/pokes') return '/activity?tab=requests';
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

  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    lang: 'en-US',
    timestamp: Date.now(),
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
