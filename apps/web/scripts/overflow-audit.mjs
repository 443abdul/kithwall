#!/usr/bin/env node
// Finds anything that makes a page wider than the phone it is shown on.
//
// One element wider than the screen is enough to break the whole app shell on Android: the browser widens
// the page, and the fixed tab bar and top bar are laid out to that width, so the last tab slides off the
// edge (seen 2026-11-12: "Wipe this device" on the Safety centre, and the segmented controls on App lock).
// This walks every page at phone widths, signed out and signed in, in a short, a long and a right-to-left
// language, and lists the elements that stick out.
//
// Needs a running dev server and a local account (never production):
//   KW_HANDLE=<handle> KW_PASS=<passphrase> node scripts/overflow-audit.mjs
//   optional: KW_BASE=http://localhost:3000  KW_WIDTHS=320,360,412  KW_LOCALES=en,ru,ur
//             KW_EXTRA=/messages/<conversation id>,/u/<handle>      (pages that need a real id)
//             KW_PUBLIC=/,/join   KW_APP=/home,/explore            (check only these instead of every page)
// Exit code 1 when something overflows, 2 when the check itself is broken (it first makes a page overflow on
// purpose and must notice).
import { chromium } from 'playwright';

const BASE = (process.env.KW_BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
const WIDTHS = (process.env.KW_WIDTHS ?? '320,360,412').split(',').map(Number);
const LOCALES = (process.env.KW_LOCALES ?? 'en,ru,ur').split(',');
const EXTRA = (process.env.KW_EXTRA ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const { KW_HANDLE: handle, KW_PASS: pass } = process.env;

const list = (v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const PUBLIC = process.env.KW_PUBLIC !== undefined ? list(process.env.KW_PUBLIC) : ['/', '/join', '/signin', '/recover', '/help', '/help/blocked', '/transparency', '/donate',
  '/legal/privacy-policy', '/legal/terms-of-service', '/offline'];
const APP = process.env.KW_APP !== undefined ? list(process.env.KW_APP) : ['/home', '/explore', '/explore?tab=people', '/reels', '/people', '/circles', '/circles/new', '/messages', '/messages/new', '/activity',
  '/albums', '/albums/new', '/events', '/events/new', '/notes', '/notes/new', '/you', '/you/kitdrop', '/you/saved',
  '/you/scheduled', '/you/search', '/you/privacy-report', '/you/safety', '/you/safety/lock', '/you/safety/hidden',
  '/you/safety/checkins', '/you/safety/devices', '/you/safety/tips', '/you/settings', '/you/settings/account',
  '/you/settings/security', '/you/settings/privacy', '/you/settings/notifications', '/you/settings/connection',
  '/you/settings/data', '/you/settings/apps', '/you/settings/about', '/you/settings/following', '/you/settings/reels'];

/** Runs in the page: how far the page is wider than the screen, and the innermost elements that stick out. */
function measure() {
  const vw = document.documentElement.clientWidth;
  const pageOver = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'visible') continue;
      // The app shell clips the page as a safety net (base.css `.kw { overflow-x: clip }`). That hides the
      // damage, not the cause: what sticks out of it is still cut off, so it still counts here.
      if (o === 'clip' && p.classList.contains('kw')) continue;
      return true;   // a scroller or clipping box of its own: not a page overflow
    }
    return false;
  };
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('nextjs-portal')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const over = Math.max(r.right - vw, -r.left);
    if (over <= 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || el.classList.contains('k-sr-only')) continue;
    if (clipped(el)) continue;
    out.push({ el, over });
  }
  // Keep the innermost offenders (an overflowing child makes all its ancestors "overflow" too).
  const inner = out.filter((o) => !out.some((x) => x !== o && o.el.contains(x.el)));
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
  return {
    pageOver: Math.round(pageOver),
    offenders: inner.sort((a, b) => b.over - a.over).slice(0, 4).map((o) => ({
      over: Math.round(o.over), el: name(o.el), in: o.el.parentElement ? name(o.el.parentElement) : '',
      text: (o.el.innerText || o.el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    })),
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const findings = [];
let pages = 0;

async function walk(ctx, paths, label) {
  const page = await ctx.newPage();
  for (const locale of LOCALES) {
    await page.goto(`${BASE}${paths[0]}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.evaluate((l) => { try { localStorage.setItem('kw.locale', l); } catch { /* blocked */ } }, locale);
    for (const path of paths) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        try {
          await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
          await page.waitForTimeout(700);
          const m = await page.evaluate(measure);
          pages++;
          if (m.pageOver > 1 || m.offenders.length) findings.push({ label, locale, width, path, ...m });
        } catch (e) {
          findings.push({ label, locale, width, path, error: String(e.message).split('\n')[0].slice(0, 120) });
        }
      }
    }
  }
  await page.close();
}

const anon = await browser.newContext({ locale: 'en-US' });
// Self-check: the app shell clips what sticks out, so a blind audit would report "clean" for ever. Make a
// page overflow on purpose and insist on seeing it.
{
  const page = await anon.newPage();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('.kw', { timeout: 30_000 });
  // Let the page finish starting up first, or React replaces the tree and the probe with it.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'overflow-audit-probe';
    probe.style.cssText = 'min-inline-size:900px;block-size:20px;flex:none';   // rigid: a flex parent must not shrink it
    (document.querySelector('.kw main') ?? document.querySelector('.kw')).append(probe);
  });
  const m = await page.evaluate(measure);
  await page.close();
  if (!m.offenders.some((o) => o.el.includes('overflow-audit-probe'))) {
    console.error('The audit did not notice an element that is 900px wide on a 320px screen: it cannot be trusted.');
    await browser.close();
    process.exit(2);
  }
}
if (PUBLIC.length) await walk(anon, PUBLIC, 'signed out');
await anon.close();

if (handle && pass && APP.length + EXTRA.length) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 412, height: 800 } });
  ctx.setDefaultTimeout(60_000);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/signin`);
  await page.getByRole('button', { name: 'Use passphrase' }).click();
  await page.getByLabel('Handle').fill(handle);
  await page.getByLabel('Passphrase', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/home', { timeout: 120_000 });
  await page.close();
  await walk(ctx, [...APP, ...EXTRA], 'signed in');
  await ctx.close();
} else if (!handle || !pass) {
  console.log('KW_HANDLE / KW_PASS not set: only the signed-out pages were checked.');
}
await browser.close();

const byKey = new Map();
for (const f of findings) {
  const key = f.error ? `error ${f.path}` : `${f.path} :: ${f.offenders.map((o) => o.el).join(' , ') || 'page'}`;
  const g = byKey.get(key) ?? { ...f, where: [] };
  g.where.push(`${f.locale}@${f.width}${f.error ? '' : `(+${Math.max(f.pageOver, ...f.offenders.map((o) => o.over), 0)}px)`}`);
  byKey.set(key, g);
}
for (const g of byKey.values()) {
  console.log(`\n${g.path}  [${g.label}]  ${g.where.join(' ')}`);
  if (g.error) console.log(`   could not check: ${g.error}`);
  for (const o of g.offenders ?? []) console.log(`   ${o.el}  in ${o.in}  "${o.text}"`);
}
console.log(`\n${pages} page views checked; ${byKey.size} with something wider than the screen.`);
process.exit(byKey.size ? 1 : 0);
