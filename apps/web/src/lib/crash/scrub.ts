// Crash reports: the scrubber. This file is the privacy boundary of the feature: everything a report says
// about an error (name, message, stack, React component stack) passes through here on the device before it
// is sent, and again on the server before it is stored (app/api/crash/route.ts), so a modified client
// can't make the server keep what the rules below remove. Pure; unit-tested hard in scrub.test.ts.
//
// What survives: the error's class name, a short message made of ASCII words, and stack frames (function
// names and code locations inside this app's own bundles). What never does:
//   - addresses: any URL that isn't one of this app's own code files is replaced whole; the app's own pages
//     become their route pattern (/messages/[id]), never the real path; query strings and fragments are
//     dropped everywhere;
//   - identifiers: UUIDs, long hex strings, tokens (JWTs, base64url blobs), @handles, e-mail and IP addresses;
//   - numbers of four digits or more and anything shaped like a phone number (line:column positions of
//     stack frames are kept);
//   - text: every run of non-ASCII characters (the app's own error messages are English, so anything in
//     another script is somebody's content), and anything in quotes unless it looks like a code identifier
//     (so "Cannot read properties of undefined (reading 'envelope')" keeps its property name, while a JSON
//     parse error that quotes the text it choked on does not);
//   - size: message ≤ 300 characters, ≤ 30 stack frames, ≤ 4,000 characters of stack.
// The limit that remains: unquoted ASCII words inside an error message can't be told apart from the
// message itself. The app's own errors don't put user content there, and "See what gets sent" shows the
// exact report, but a browser or library message could in principle carry a word of it.

export const NAME_MAX = 80;
export const MESSAGE_MAX = 300;
export const FRAME_MAX = 240;
export const FRAMES_MAX = 30;
export const STACK_MAX = 4000;
export const COMPONENT_FRAMES_MAX = 15;
export const COMPONENT_STACK_MAX = 1500;
/** Nothing longer than this is ever looked at (bounds the work done on hostile input). */
const INPUT_MAX = 16_000;

export interface ScrubContext {
  /** Origins this app is served from (https://www.kithwall.com, mirrors, a local dev server). */
  appOrigins: readonly string[];
  /** Origins of the app's own API (the Supabase project): their paths are kept, without ids. */
  apiOrigins?: readonly string[];
  /** Route pattern of one of the app's own page paths (lib/crash/routes.ts). */
  route: (pathname: string) => string;
}

export interface RawCrash { name?: unknown; message?: unknown; stack?: unknown; componentStack?: unknown }
export interface ScrubbedCrash { name: string; message: string; stack: string; componentStack: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '').slice(0, INPUT_MAX).replace(/\u0000/g, '');

// Placeholders stand in for parts already dealt with (addresses, code locations) while the generic rules
// run over the rest; NUL can't occur in the input (removed above).
const HOLD = '\u0000';
const holdRe = /\u0000(\d+)\u0000/g;
class Held {
  private parts: string[] = [];
  hold(s: string): string { return `${HOLD}${this.parts.push(s) - 1}${HOLD}`; }
  release(s: string): string { return s.replace(holdRe, (_, i: string) => this.parts[Number(i)] ?? ''); }
}

// An address runs to the next space, quote or bracket; "(app)" and "[::1]" inside it belong to it, a closing
// bracket that was never opened (the one around a stack frame's location) does not.
const URL_RE = /\b(?:blob:|data:)[^\s"'`<>)\]]+|\b[a-z][a-z0-9+.-]{1,24}:\/\/(?:[^\s"'`<>()[\]]|\([^\s"'`<>()]*\)|\[[^\s"'`<>[\]]*\])*/gi;
const CODE_SCHEMES = new Set(['webpack-internal:', 'webpack:', 'turbopack:', 'node:']);
/** "file.js:12:345", "<anonymous>:1:2", "MainActivity.java:88": a code location, kept as it is. */
const LOCATION_RE = /(?:<anonymous>|[\w$-]+(?:\.[\w$-]+)*\.(?:m?js|jsx|tsx?|java|kt)):\d{1,7}(?::\d{1,7})?/g;
/** A file of this app's own build output, already without its origin ("/_next/static/chunks/1a2b.js:1:99"). */
const CODE_PATH_RE = /\/_next\/[\w./()[\]~@%+-]{1,200}?\.(?:m?js|css)(?::\d{1,7}){0,2}(?![\w.])/g;
const codePath = (pathname: string): string => (/^\/_next\/[\w./()[\]~@%+-]{1,200}?\.(?:m?js|css)$/.test(pathname) ? pathname : '/_next/<path>');

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const HANDLE_RE = /(^|[^\w/.@-])@[a-z0-9_][a-z0-9_.-]{1,31}/gi;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JWT_RE = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6_RE = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/gi;
/** A long run of base64url characters with both letters and digits: a key, token or opaque id. */
const WORDISH_RE = /[\w-]{24,}/g;
const PHONE_RE = /\+?\d[\d ().-]{5,}\d/g;
const DIGITS_RE = /\d{4,}/g;
const NON_ASCII_RE = /[^\x00-\x7f]+/g;

const tokenish = (m: string) => (/\d/.test(m) && /[a-z]/i.test(m) ? '<token>' : m);

/** Path segments that are ids rather than names: scrubbed with the same rules as free text. */
function scrubPath(path: string): string {
  return path.split('/').map((seg) => {
    let s: string;
    try { s = decodeURIComponent(seg); } catch { s = seg; }
    if (s.length > 80) return '<id>';
    s = s.replace(NON_ASCII_RE, '<text>').replace(EMAIL_RE, '<email>').replace(UUID_RE, '<id>').replace(JWT_RE, '<token>')
      .replace(HEX_RE, '<hex>').replace(WORDISH_RE, tokenish).replace(DIGITS_RE, '<n>');
    return s.replace(/[^\w.<>@()[\]~+-]/g, '_');
  }).join('/');
}

function scrubUrl(raw: string, ctx: ScrubContext): string {
  if (/^blob:/i.test(raw)) return 'blob:<id>';
  if (/^data:/i.test(raw)) return '<data>';
  // "…/chunk.js:12:345": the position belongs to the stack frame, not to the address.
  const pos = /(:\d{1,7}){1,2}$/.exec(raw);
  const body = pos ? raw.slice(0, pos.index) : raw;
  const at = pos ? pos[0] : '';
  let u: URL;
  try { u = new URL(body); } catch { return '<url>'; }
  if (CODE_SCHEMES.has(u.protocol)) return `${u.protocol}//${scrubPath(u.pathname)}${at}`;
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return '<url>';
  const origin = `${u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol}//${u.host}`;
  if (ctx.appOrigins.includes(origin)) {
    // The app's own code (hashed bundle files) and API routes keep their path; a page becomes its pattern.
    if (u.pathname.startsWith('/_next/')) return `${codePath(u.pathname)}${at}`;
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/sb/')) return `<app>${scrubPath(u.pathname)}`;
    if (/\.(?:m?js|css|json|wasm|png|svg|webmanifest)$/i.test(u.pathname)) return `${scrubPath(u.pathname)}${at}`;
    return `<app>${ctx.route(u.pathname)}`;
  }
  if (ctx.apiOrigins?.includes(origin)) return `<api>${scrubPath(u.pathname)}`;
  return '<url>';
}

/** What scrubUrl() wrote on an earlier pass ("<app>/messages/[id]", "<api>/rest/v1/messages"): checked again, not trusted. */
const DONE_RE = /<(app|api)>((?:\/(?:[\w.~@%+\-[\]]|<[a-z]+>)*)*)/g;
function recheck(kind: string, path: string, ctx: ScrubContext): string {
  if (kind === 'api' || path.startsWith('/api/') || path.startsWith('/sb/')) return `<${kind}>${scrubPath(path)}`;
  return `<app>${ctx.route(path)}`;
}
/** A file path outside any address (/data/user/0/…, C:\Users\…): two or more separators. */
const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][^\s\\/"'`<>()]+){2,}[\\/]?/g;

/** Addresses and code locations are made final and set aside, so the generic rules can't touch them. */
function protect(s: string, ctx: ScrubContext, held: Held): string {
  return s.replace(URL_RE, (m) => held.hold(scrubUrl(m, ctx)))
    .replace(DONE_RE, (_, kind: string, path: string) => held.hold(recheck(kind, path, ctx)))
    .replace(CODE_PATH_RE, (m) => held.hold(m))
    .replace(LOCATION_RE, (m) => held.hold(m))
    .replace(FILE_PATH_RE, () => held.hold('<path>'));
}

/** The generic rules, for text that may contain anything. */
function rules(input: string): string {
  return input.replace(NON_ASCII_RE, '<text>')
    .replace(EMAIL_RE, '<email>')
    .replace(HANDLE_RE, '$1<handle>')
    .replace(UUID_RE, '<id>')
    .replace(JWT_RE, '<token>')
    .replace(IPV4_RE, '<ip>')
    .replace(IPV6_RE, (m) => (m.split(':').length >= 4 ? '<ip>' : m))
    .replace(HEX_RE, '<hex>')
    .replace(WORDISH_RE, tokenish)
    .replace(PHONE_RE, (m) => ((m.match(/\d/g)?.length ?? 0) >= 7 ? '<n>' : m))
    .replace(DIGITS_RE, '<n>')
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f]/g, ' ');
}

function scrubText(input: string, ctx: ScrubContext): string {
  const held = new Held();
  return held.release(rules(protect(input, ctx, held)));
}

/** A class name such as TypeError, DOMException or java.lang.IllegalStateException; anything else is "Error". */
export function scrubName(name: unknown): string {
  const n = str(name).trim();
  return n.length <= NAME_MAX && /^[A-Za-z_$][\w$.]*$/.test(n) && !/\d{4,}/.test(n) ? n : 'Error';
}

const CODE_LIKE = /^[A-Za-z_$][\w$.[\]()?!:-]{0,59}$/;
/**
 * Where browser engines quote a piece of CODE (a property, method or interface name) rather than a value:
 * "(reading 'x')", "Failed to execute 'x' on 'Y'", "Failed to read the 'x' property from 'Y'". Anywhere
 * else, what stands in quotes is treated as somebody's text.
 */
const ENGINE_QUOTE = /(?:\((?:reading|setting|evaluating) |^Failed to (?:execute|construct|read the|set the) |' on |' property (?:on|from) |(?:read|set) property )$/;
/** A quoted span: "…", `…`, or '…' where the apostrophes aren't inside a word (can't, it's). */
const QUOTED_RE = /"([^"]{0,400})"|`([^`]{0,400})`|(^|[^A-Za-z0-9])'([^']{0,400})'(?![A-Za-z0-9])/g;
const OPEN_QUOTE_RE = /["`]|(?:^|[^A-Za-z0-9])'/;

/**
 * Quoted text. Kept only where an engine quotes a code name (ENGINE_QUOTE) and it looks like one; the
 * message ends at the first quote that holds anything else, or that never closes. Cutting (rather than
 * replacing each span) matters: a parse error that quotes its input can contain quotes itself, and the
 * words between two inner quotes would otherwise be left standing.
 */
function cutAtQuotedText(s: string): string {
  let masked = s;
  QUOTED_RE.lastIndex = 0;
  for (let m = QUOTED_RE.exec(s); m; m = QUOTED_RE.exec(s)) {
    const body = m[1] ?? m[2] ?? m[4] ?? '';
    const start = m.index + (m[3]?.length ?? 0);
    if (!CODE_LIKE.test(body) || !ENGINE_QUOTE.test(s.slice(0, start))) return `${s.slice(0, start)}<text>`;
    masked = `${masked.slice(0, start)}${'x'.repeat(m.index + m[0].length - start)}${masked.slice(m.index + m[0].length)}`;
  }
  const open = OPEN_QUOTE_RE.exec(masked);
  if (!open) return s;
  return `${s.slice(0, open.index + open[0].length - 1)}<text>`;
}

export function scrubMessage(message: unknown, ctx: ScrubContext): string {
  let s = str(message).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Addresses first, so the quote rule can't cut one in half (a quoted address is dropped with its quotes).
  const held = new Held();
  s = cutAtQuotedText(protect(s, ctx, held));
  s = held.release(rules(s));
  return s.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);
}

const V8_FRAME = /^\s*at\s+\S/;
/** Firefox / Safari: "fn@https://…:1:2", "@https://…", "fn@[native code]". */
const GECKO_FRAME = /^\s*[^\s@]{0,200}@(?:\S+:\/\/|\[native code\]|blob:|<anonymous>|\/_next\/|<(?:url|app|api|data)>)/;

function scrubFrames(stack: unknown, ctx: ScrubContext, maxFrames: number, maxChars: number): string {
  const out: string[] = [];
  let size = 0;
  for (const raw of str(stack).split(/\r?\n/, 400)) {
    // Only lines that are stack frames: the header ("TypeError: …") and wrapped message lines repeat the
    // message, which is scrubbed separately and more strictly.
    if (!V8_FRAME.test(raw) && !GECKO_FRAME.test(raw)) continue;
    const line = scrubText(raw.slice(0, 1000), ctx).replace(/\s+/g, ' ').trim().slice(0, FRAME_MAX);
    if (!line) continue;
    if (size + line.length + 1 > maxChars) break;
    out.push(line);
    size += line.length + 1;
    if (out.length >= maxFrames) break;
  }
  return out.join('\n');
}

export function scrubStack(stack: unknown, ctx: ScrubContext): string {
  return scrubFrames(stack, ctx, FRAMES_MAX, STACK_MAX);
}

export function scrubComponentStack(stack: unknown, ctx: ScrubContext): string {
  return scrubFrames(stack, ctx, COMPONENT_FRAMES_MAX, COMPONENT_STACK_MAX);
}

/** Everything a report says about the error itself. Idempotent: scrubbing a scrubbed report changes nothing. */
export function scrubCrash(raw: RawCrash, ctx: ScrubContext): ScrubbedCrash {
  const name = scrubName(raw.name);
  return {
    name,
    message: scrubMessage(raw.message, ctx),
    stack: scrubStack(raw.stack, ctx),
    componentStack: scrubComponentStack(raw.componentStack, ctx),
  };
}

/**
 * What reports of the same bug have in common: the error class and the first frames with positions,
 * build hashes and numbers removed, so the same crash groups together across devices (and across builds
 * where the bundler kept the names). The server hashes this (SHA-256) into the fingerprint it groups by.
 */
export function fingerprintSource(name: string, stack: string): string {
  const frames = stack.split('\n').slice(0, 6).map((f) => f
    .replace(/(:\d+){1,2}(?=\)?$)/, '')
    .replace(/<(?:hex|token|id|n)>/g, '')
    .replace(/\b(?=[a-f]*\d)[0-9a-f]{8,}\b/gi, '')
    .replace(/[-._][0-9a-z]*\d[0-9a-z]*(?=[-._/)]|$)/gi, '')
    .replace(/\d+/g, '')
    .trim());
  return [name, ...frames].join('\n');
}
