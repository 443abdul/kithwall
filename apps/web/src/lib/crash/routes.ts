// Route patterns for crash reports: a report names the screen as "/messages/[id]", never the real path
// (which holds chat ids and @handles). Matching is by position against the app's own page routes, so the
// answer is always one of the strings below; a path that matches none of them is "/[unknown]".
// Pure. routes.test.ts fails when a page is added under src/app without its pattern here.

/** Every page route of the app (src/app/**\/page.tsx without the route groups), plus the API prefix. */
export const ROUTE_PATTERNS: readonly string[] = [
  '/', '/[handle]', '/[handle]/[...rest]', '/activity', '/albums', '/albums/[id]', '/albums/new',
  '/circles', '/circles/[id]', '/circles/[id]/settings', '/circles/new', '/design/[[...screen]]', '/donate',
  '/events', '/events/[id]', '/events/[id]/edit', '/events/new', '/help', '/help/blocked', '/home', '/join',
  '/legal/[doc]', '/messages', '/messages/[id]', '/messages/circle/[circleId]', '/messages/new', '/mod',
  '/notes', '/notes/[id]', '/notes/[id]/edit', '/notes/new', '/offline', '/people', '/post/[id]', '/recover',
  '/setup', '/signin', '/transparency', '/u/[handle]', '/u/[handle]/verify', '/you', '/you/kitdrop',
  '/you/privacy-report', '/you/safety', '/you/safety/checkins', '/you/safety/devices', '/you/safety/hidden',
  '/you/safety/lock', '/you/safety/tips', '/you/saved', '/you/scheduled', '/you/search', '/you/settings',
  '/you/settings/about', '/you/settings/account', '/you/settings/apps', '/you/settings/connection',
  '/you/settings/data', '/you/settings/notifications', '/you/settings/privacy', '/you/settings/security',
];

export const UNKNOWN_ROUTE = '/[unknown]';

interface Compiled { pattern: string; segs: string[]; statics: number; rest: 'none' | 'some' | 'any' }
const compiled: Compiled[] = ROUTE_PATTERNS.map((pattern) => {
  const segs = pattern.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const rest = last.startsWith('[[...') ? 'any' : last.startsWith('[...') ? 'some' : 'none';
  return { pattern, segs: rest === 'none' ? segs : segs.slice(0, -1), statics: segs.filter((s) => !s.startsWith('[')).length, rest };
});

function matches(c: Compiled, path: string[]): boolean {
  if (c.rest === 'none' ? path.length !== c.segs.length : path.length < c.segs.length + (c.rest === 'some' ? 1 : 0)) return false;
  return c.segs.every((s, i) => s.startsWith('[') || s === path[i]);
}

/** The pattern of an app path ("/messages/3f2c…" → "/messages/[id]"). Query strings never get here. */
export function routePattern(pathname: string): string {
  const clean = (pathname.split(/[?#]/)[0] ?? '').slice(0, 2048);
  if (clean === UNKNOWN_ROUTE) return UNKNOWN_ROUTE;
  const path = clean.split('/').filter(Boolean);
  if (path[0] === 'api') return '/api';
  let best: Compiled | null = null;
  for (const c of compiled) {
    if (!matches(c, path)) continue;
    // The most specific route wins, as in the router: static segments beat parameters.
    if (!best || c.statics > best.statics || (c.statics === best.statics && c.rest === 'none' && best.rest !== 'none')) best = c;
  }
  return best ? best.pattern : UNKNOWN_ROUTE;
}

/** Is this string one of the answers routePattern() can give? (The server refuses anything else.) */
export function isRoutePattern(s: unknown): s is string {
  return typeof s === 'string' && (s === UNKNOWN_ROUTE || s === '/api' || ROUTE_PATTERNS.includes(s));
}
