// Release-build check on a real device or emulator (docs/v2/05-native.md §11): the things that broke in
// 2.0.0 to 2.3.0 only in RELEASE builds and so were never seen in debug testing.
//   1. R8 keeps Capacitor's permission annotations (they were emptied: no permission was ever requested);
//   2. "Turn on notifications" really shows Android's dialog, and every request gets an answer:
//      "Don't allow", the silent refusal after two denials (blocked), and "Allow";
//   3. a push token can be fetched;
//   4. the bundled offline page returns to the app's own origin (it pointed at a developer address).
//
// Needs: adb on PATH (or ANDROID_HOME), one device with Android 13+, and a release APK built with
// `android.webContentsDebuggingEnabled: true` in the synced capacitor.config.json (never ship that build).
// Usage: node scripts/verify-release.mjs <path-to-apk> [--origin https://www.kithwall.com]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const apk = args.find((a) => !a.startsWith('--'));
const origin = (args[args.indexOf('--origin') + 1] && args.includes('--origin') ? args[args.indexOf('--origin') + 1] : 'https://www.kithwall.com').replace(/\/+$/, '');
if (!apk || !existsSync(apk)) { console.error('usage: node scripts/verify-release.mjs <apk> [--origin https://…]'); process.exit(2); }

const PKG = 'com.kithwall.app';
const PERM = 'android.permission.POST_NOTIFICATIONS';
const PORT = 9333;
const sdk = process.env.ANDROID_HOME || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '');
const adbBin = sdk && existsSync(join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'))
  ? join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb';
const adb = (...a) => execFileSync(adbBin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
const sh = (cmd) => { try { return adb('shell', cmd); } catch (e) { return String(e.stdout ?? ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** What is on screen: [{text, x, y}] (centre of each labelled node). */
function screen() {
  const xml = sh('uiautomator dump /sdcard/kw-ui.xml >/dev/null 2>&1; cat /sdcard/kw-ui.xml');
  return [...xml.matchAll(/text="([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .map((m) => ({ text: m[1].replace(/&apos;|’/g, "'"), x: (Number(m[2]) + Number(m[4])) >> 1, y: (Number(m[3]) + Number(m[5])) >> 1 }));
}
/** Slow emulators raise "isn't responding" dialogs: answer "Wait". Returns the nodes once none is showing. */
async function settled() {
  for (let i = 0; i < 6; i++) {
    const nodes = screen();
    const wait = nodes.find((n) => n.text === 'Wait');
    if (!wait || !nodes.some((n) => /isn't responding/.test(n.text))) return nodes;
    adb('shell', 'input', 'tap', String(wait.x), String(wait.y));
    await sleep(2500);
  }
  return screen();
}
async function waitFor(pred, ms = 40_000) {
  const until = Date.now() + ms;
  for (;;) {
    const nodes = await settled();
    const hit = nodes.find(pred);
    if (hit || Date.now() > until) return hit ?? null;
    await sleep(1500);
  }
}
const tap = (n) => adb('shell', 'input', 'tap', String(n.x), String(n.y));

// ---- the page, through the WebView's DevTools socket --------------------------------------------------
async function connect() {
  for (let i = 0; i < 40; i++) {
    const pid = sh(`pidof ${PKG}`).split(/\s+/)[0];
    if (pid && sh('cat /proc/net/unix').includes(`webview_devtools_remote_${pid}`)) {
      try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* none yet */ }
      adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
      try {
        const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        const page = pages.find((p) => p.type === 'page');
        if (page) return page;
      } catch { /* not listening yet */ }
    }
    await sleep(2000);
  }
  throw new Error('The app\'s WebView is not debuggable or did not start. Build with webContentsDebuggingEnabled.');
}
/** Evaluate in the page; resolves {value} | {error} | {pending: true} when it doesn't settle within `ms`. */
async function evaluate(expression, ms = 20_000) {
  const page = await connect();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('devtools socket')); });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.close(); resolve({ pending: true, url: page.url }); }, ms);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      const v = d.result?.result?.value;
      resolve(typeof v === 'string' && v.startsWith('ERR ') ? { error: v, url: page.url } : { value: v === undefined ? undefined : JSON.parse(v), url: page.url });
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async()=>{try{const r=await (${expression});return r===undefined?undefined:JSON.stringify(r)}catch(e){return 'ERR '+((e&&e.code)||'')+' '+(e&&e.message)}})()`,
      awaitPromise: true, returnByValue: true } }));
  });
}
const push = (method, ms) => evaluate(`Capacitor.nativePromise('KithwallPush','${method}',{})`, ms);

async function launch() {
  sh(`am force-stop ${PKG}`);
  sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    await settled();
    const r = await evaluate('({native: !!(window.Capacitor && Capacitor.isNativePlatform()), href: location.href, ready: document.readyState})', 8000).catch(() => null);
    if (r?.value?.native && r.value.ready === 'complete') return r.value;
  }
  throw new Error('the app did not load its page');
}
function resetPermission() {
  sh(`pm revoke ${PKG} ${PERM}`);
  sh(`pm clear-permission-flags ${PKG} ${PERM} user-set user-fixed`);
}
/** Start a request without waiting for it; `result()` gives its answer later. */
function request() {
  const p = push('requestPermission', 120_000);
  return { result: () => p };
}
const dialog = (n) => /send you notifications/i.test(n.text);

// ---- run ----------------------------------------------------------------------------------------------
const sdkLevel = Number(sh('getprop ro.build.version.sdk'));
if (!(sdkLevel >= 33)) { console.error(`Needs Android 13+ (this device: API ${sdkLevel}).`); process.exit(2); }
console.log(`Device: Android ${sh('getprop ro.build.version.release')} (API ${sdkLevel}); installing ${apk}`);
try { adb('uninstall', PKG); } catch { /* not installed */ }
adb('install', apk);
sh('cmd connectivity airplane-mode disable');

let start = await launch();
check('app loads its own origin', start.href.startsWith(origin + '/'), start.href);

const perms = await push('checkPermissions');
check('R8 kept the plugin\'s permission annotations', !!perms.value && 'notifications' in perms.value, JSON.stringify(perms.value ?? perms));
const st = await push('permission');
check('fresh install: permission can be asked', st.value?.state === 'prompt', JSON.stringify(st.value ?? st));

// "Don't allow", twice: Android then refuses by itself.
for (const round of [1, 2]) {
  const req = request();
  const d = await waitFor(dialog);
  check(`request ${round}: Android shows its notification dialog`, !!d);
  const deny = (await settled()).find((n) => /^Don't allow$/i.test(n.text));
  if (deny) tap(deny);
  const r = await req.result();
  check(`request ${round}: "Don't allow" is answered, not blocked`, r.value?.state !== 'granted' && r.value?.blocked === false, JSON.stringify(r.value ?? r));
  await sleep(1500);
}
{
  const t0 = Date.now();
  const r = await push('requestPermission', 30_000);
  check('after two refusals: answered at once as blocked (the page opens the settings)', r.value?.blocked === true && r.value?.state !== 'granted', `${JSON.stringify(r.value ?? r)} in ${Date.now() - t0} ms`);
}

// "Allow".
resetPermission();
start = await launch();
{
  const req = request();
  const d = await waitFor(dialog);
  check('after a reset: the dialog shows again', !!d);
  const allow = (await settled()).find((n) => /^Allow$/i.test(n.text));
  if (allow) tap(allow);
  const r = await Promise.race([req.result(), sleep(25_000).then(() => ({ pending: true }))]);
  if (r.pending) console.log('      still waiting after 25 s; on screen:', JSON.stringify((await settled()).map((n) => n.text).slice(0, 6)), '| granted:', sh(`dumpsys package ${PKG} | grep "POST_NOTIFICATIONS: granted"`).trim());
  check('"Allow" is answered as granted', r.value?.state === 'granted', JSON.stringify(r.value ?? r));
  const reg = await evaluate(`Capacitor.nativePromise('KithwallPush','register',{}).then(r=>({provider:r.provider,token:(r.token||'').length,key:!!r.p256dh}))`, 60_000);
  check('a push token is issued', reg.value?.token > 20 && reg.value?.key === true, JSON.stringify(reg.value ?? reg));
}

// Offline page: bundled page for this origin, and back to the app when the connection returns.
sh('cmd connectivity airplane-mode enable');
await sleep(4000);
sh(`am force-stop ${PKG}`);
sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
let off = null;
for (let i = 0; i < 20 && !off?.value?.retry; i++) {
  await sleep(3000);
  await settled();
  off = await evaluate(`({href: location.href, retry: (document.getElementById('retry')||{}).href, html: document.documentElement.outerHTML.includes('127.0.0.1')})`, 8000).catch(() => null);
}
check('offline: the bundled page is shown', /\/offline\.html/.test(off?.value?.href ?? ''), off?.value?.href);
check('offline page: "Try again" goes to the app\'s own origin', off?.value?.retry === origin + '/' && off?.value?.html === false, off?.value?.retry);
sh('cmd connectivity airplane-mode disable');
let back = null;
for (let i = 0; i < 30 && !(back?.value ?? '').startsWith(origin + '/'); i++) {
  await sleep(3000);
  await settled();
  back = await evaluate('location.href', 8000).catch(() => null);
}
check('back online: the app returns to its own origin by itself', (back?.value ?? '').startsWith(origin + '/'), back?.value);

try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* gone */ }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
