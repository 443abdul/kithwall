'use client';
// Things a browser does for a web page that an Android/iOS WebView doesn't (docs/v2/05-native.md §1, "App
// frame"). Loaded only inside the app (components/native/NativeRuntime.tsx imports it dynamically).
//  - Back button: window.__kwBack, asked by MainActivity before it goes back in history (closes the top
//    dialog / sheet / viewer first, leaves the app from Home).
//  - Downloads: a WebView ignores <a download href="blob:…">. Every "save a file" in the web app (data export,
//    .ics, photo / video download) goes through an object URL and an anchor click; here those clicks stream
//    the blob to KithwallShell.download* (written to Downloads on Android).
//  - Share: Android WebView has no navigator.share; it goes to the system share sheet.
//  - Status bar icons follow the page's own light/dark mode (which can differ from the system's).
import { isNative, nativePlatform, nativePlugin } from './index';
import { nativeCallActive, nativeCallEnded } from './calls';

// ---------------------------------------------------------------------------------------------------------
// Back

type BackAnswer = 'handled' | 'background' | '';

const HOME_PATHS = new Set(['/', '/home', '/signin', '/join']);
const OVERLAYS = '[aria-modal="true"], [role="menu"], .kw-menu, .ov';

function visible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  return !!r && r.width > 0 && r.height > 0;
}

/** What Android Back should do on this page. Exported for tests. */
export function backAction(canGoBack: boolean, doc: Document = document, path: string = location.pathname): BackAnswer {
  // A call stays on screen: Back puts the app in the background (the call keeps going), like phone apps.
  if (doc.querySelector('.k-call-screen, .k-call-incoming')) return 'background';
  // The top-most modal <dialog> (components/ui/Dialog.tsx and the media viewers): same as pressing Esc.
  const dialogs = Array.from(doc.querySelectorAll<HTMLDialogElement>('dialog[open]'));
  const top = dialogs[dialogs.length - 1];
  if (top) {
    if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
    return 'handled';
  }
  // Other overlays (photo viewer, menus) close on Escape.
  const overlay = Array.from(doc.querySelectorAll(OVERLAYS)).filter(visible).pop();
  if (overlay) {
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return 'handled';
  }
  // Home (or the signed-out start pages): leave the app.
  if (HOME_PATHS.has(path.replace(/\/+$/, '') || '/')) return 'background';
  // Opened straight into a page (notification, link) with no history: Back goes Home first.
  if (!canGoBack) {
    const home = doc.querySelector<HTMLAnchorElement>('a[href="/home"]');
    if (home) { home.click(); return 'handled'; }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------
// Downloads

const blobs = new Map<string, Blob>();
const CHUNK = 768 * 1024; // 1 MiB of base64 per bridge call

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function dataUrlBlob(href: string): Blob | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(href);
  if (!m) return null;
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
  return new Blob([out], { type: m[1] || 'application/octet-stream' });
}

/** The blob behind an <a download> the WebView can't save itself, or null (a normal link). */
export function downloadBlob(a: HTMLAnchorElement): Blob | null {
  if (!a.hasAttribute('download')) return null;
  const href = a.href;
  if (href.startsWith('blob:')) return blobs.get(href) ?? null;
  if (href.startsWith('data:')) return dataUrlBlob(href);
  return null;
}

async function saveBlob(blob: Blob, name: string): Promise<void> {
  const shell = await nativePlugin('KithwallShell');
  const { id } = await shell.downloadStart({ name: name || 'download', mime: blob.type });
  try {
    for (let off = 0; off < blob.size; off += CHUNK) {
      const part = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
      await shell.downloadChunk({ id, data: b64(part) });
    }
    await shell.downloadFinish({ id });
  } catch (e) {
    await shell.downloadAbort({ id }).catch(() => undefined);
    throw e;
  }
}

function installDownloads() {
  // Keep a reference to every object URL's blob (the browser does the same until revokeObjectURL), so a
  // download link can be saved without fetch() (the page CSP doesn't allow blob: in connect-src).
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (o: Blob | MediaSource) => {
    const u = create(o);
    if (o instanceof Blob) blobs.set(u, o);
    return u;
  };
  URL.revokeObjectURL = (u: string) => { blobs.delete(u); revoke(u); };

  const save = (a: HTMLAnchorElement): boolean => {
    const blob = downloadBlob(a);
    if (!blob) return false;
    const name = a.getAttribute('download') || a.href.split('/').pop() || 'download';
    saveBlob(blob, name).catch(() => undefined); // the app shows "Couldn't save the file"
    return true;
  };
  // Programmatic downloads (lib/export.ts saveBlob, lib/events.ts, lib/photos.ts …) …
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!save(this)) click.call(this);
  };
  // … and download links the person taps (components/posts/Media.tsx).
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[download]');
    if (a instanceof HTMLAnchorElement && save(a)) e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------------------------------------------------
// Share

/** navigator.share for the app (Android WebView doesn't implement it). */
export async function nativeShare(data: ShareData = {}): Promise<void> {
  try {
    await (await nativePlugin('KithwallShell')).share({ title: data.title, text: data.text, url: data.url });
  } catch {
    throw new DOMException('Share failed', 'AbortError');
  }
}

// ---------------------------------------------------------------------------------------------------------
// System bars

function syncSystemBars() {
  const root = document.documentElement;
  let last = '';
  const apply = () => {
    // 'DARK' = dark content behind the bars → light icons.
    const style = root.getAttribute('data-mode') === 'dark' ? 'DARK' : 'LIGHT';
    if (style === last) return;
    last = style;
    nativePlugin('SystemBars').then((p) => p.setStyle({ style })).catch(() => undefined);
  };
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-mode'] });
  apply();
}

// ---------------------------------------------------------------------------------------------------------
// Calls: until the call UI calls lib/native/calls.ts itself, follow the call screen being on screen (one
// cheap query a second). Video calls (a camera track in a <video>) use the speaker, voice calls too (the call
// screen has no earpiece switch yet).

function watchCalls() {
  let state = '';
  setInterval(() => {
    const screen = document.querySelector('.k-call-screen:not(.is-ended)');
    const video = !!screen && Array.from(screen.querySelectorAll('video')).some((v) => {
      const s = v.srcObject;
      return s instanceof MediaStream && s.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
    });
    const next = screen ? (video ? 'video' : 'voice') : '';
    if (next === state) return;
    state = next;
    if (next) void nativeCallActive({ speaker: true, video });
    else void nativeCallEnded();
  }, 1000);
}

// ---------------------------------------------------------------------------------------------------------
// Edge-to-edge details (Android draws the page behind transparent system bars)

/**
 * Pages without a top bar (sign-in, join, landing, public pages) scrolled their content under the clock and
 * battery icons. A strip in the page colour sits behind the status bar while such a page is scrolled
 * (pages with a top bar or chat header already cover it themselves).
 */
function statusBarScrim() {
  const scrim = document.createElement('div');
  scrim.setAttribute('aria-hidden', 'true');
  scrim.style.cssText = 'position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:var(--bg);z-index:20;pointer-events:none;display:none';
  document.body.appendChild(scrim);
  let raf = 0;
  const update = () => {
    raf = 0;
    const show = window.scrollY > 0 && !document.querySelector('.k-topbar, .k-chat-head');
    scrim.style.display = show ? 'block' : 'none';
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
}

/**
 * The app's WebView resizes the page when the keyboard opens (a browser only shrinks the visual viewport),
 * so an open chat lost its newest messages behind the composer. Keep a chat that was at the bottom there.
 */
function keepChatAtBottom() {
  const atBottom = new WeakMap<Element, boolean>();
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (el instanceof HTMLElement && el.classList.contains('k-chat-scroll')) {
      atBottom.set(el, el.scrollHeight - el.scrollTop - el.clientHeight < 64);
    }
  }, { capture: true, passive: true });
  addEventListener('resize', () => requestAnimationFrame(() => {
    document.querySelectorAll<HTMLElement>('.k-chat-scroll').forEach((el) => {
      if (atBottom.get(el) ?? true) el.scrollTop = el.scrollHeight;
    });
  }));
}

let started = false;
/** Called once per page load inside the app. */
export function startNativeRuntime(): void {
  if (started || !isNative()) return;
  started = true;
  const w = window as unknown as { __kwBack?: (canGoBack: boolean) => BackAnswer };
  w.__kwBack = (canGoBack) => backAction(!!canGoBack);
  if (nativePlatform() === 'android') { installDownloads(); watchCalls(); }
  syncSystemBars();
  statusBarScrim();
  keepChatAtBottom();
}
