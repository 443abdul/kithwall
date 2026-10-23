// What a link really points at, for the "Leaving Kithwall" sheet (components/links/LeaveSheet.tsx).
// Pure (no DOM, no network, no '@/' imports): unit-tested in analyze.test.ts.
//
//   analyzeLink(href, visibleText?) → {
//     navigable,           false for data:, javascript:, file:, blob: … (rendered as plain text, never opened)
//     openUrl,             the address that is opened / copied: tracking parameters and user:pass@ removed
//     host, domain, …      the real destination; `domain` is the registrable domain (public-suffix aware, tldts)
//     unicodeHost,         what an IDN ("xn--…") hostname spells, when it is one
//     removed,             tracking parameters taken out of openUrl
//     warnings,            reasons to look twice (see LinkWarning); any warning makes the link "flagged":
//   }                      the person is always asked, and "don't ask again" is not offered.
//
// The registrable domain comes from the Public Suffix List (tldts, private suffixes included, so
// someone.github.io is its own site). This module is only loaded when a link is tapped.
import { parse } from 'tldts';
import { toUnicode } from './punycode';

export type LinkWarning =
  | 'insecure'            // http:
  | 'ip'                  // a bare IP address instead of a name
  | 'userinfo'            // https://google.com@evil.example — everything before @ is ignored by the browser
  | 'mixedScript'         // IDN label mixing scripts (Latin + Cyrillic …)
  | 'confusable'          // IDN label made of letters that look like Latin ones (аррӏе.com)
  | 'mismatch'            // the visible text names a different site than the link goes to
  | 'shortener'           // bit.ly & co: the final destination is hidden
  | 'deceptiveSubdomain'  // paypal.com.account-check.example: a familiar name in front of another site
  | 'long'                // very long address
  | 'obfuscated'          // heavy percent-encoding, numeric host tricks, deep subdomain chains
  | 'port';               // unusual port

export interface LinkReport {
  navigable: boolean;
  /** The scheme without ':' ("https", "http", "javascript" …). */
  scheme: string;
  /** The URL exactly as given (normalised by the URL parser). */
  original: string;
  /** What "Open" / "Copy link" use: no tracking parameters, no user:pass@. Empty when not navigable. */
  openUrl: string;
  /** ASCII hostname (Punycode for IDNs). */
  host: string;
  /** What an IDN hostname spells; null for plain ASCII hosts. */
  unicodeHost: string | null;
  /** Registrable domain ("example.co.uk"); null for IP addresses and unknown suffixes. */
  domain: string | null;
  /** The part of `host` in front of `domain` ("www", "mail.eu"), '' if none. */
  subdomain: string;
  isIp: boolean;
  port: string;
  removed: string[];
  warnings: LinkWarning[];
  /** Any warning: always ask, and never offer "don't ask again". */
  flagged: boolean;
  /** For 'mismatch': the domain the visible text claims. */
  claimed?: string;
  /** For 'userinfo': what was in front of the @. */
  userinfo?: string;
}

/** Link shorteners and redirectors that hide the real destination. */
export const SHORTENERS = new Set([
  'bit.ly', 'bitly.com', 'j.mp', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'v.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'shorturl.com', 'tiny.cc', 'rb.gy', 'bl.ink', 's.id', 't.ly', 'lnkd.in', 'amzn.to', 'a.co',
  'fb.me', 'wp.me', 'trib.al', 'dlvr.it', 'ift.tt', 'shorte.st', 'adf.ly', 'bc.vc', 'soo.gd', 'clck.ru', 'u.to', 'x.co',
  'su.pr', 'po.st', 'mcaf.ee', 'db.tt', 'short.gy', 'short.io', 'han.gl', 'me2.do', 'vk.cc', 'qr.ae', 'tny.im', 'gg.gg',
  'urlz.fr', 'tinu.be', 'shrtco.de', '1url.com', 'surl.li', 'lih.kg', 'n9.cl', 'zpr.io', 'kutt.it', 'tiny.one',
]);

// ---------------------------------------------------------------------------------------------
// Tracking parameters

const TRACK_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'igshid', 'igsh', 'mc_cid', 'mc_eid', '_hsenc',
  '_hsmi', 'mkt_tok', 'yclid', 'ysclid', 'twclid', 'ttclid', 'li_fat_id', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
  'rb_clickid', '_ga', '_gl', 'srsltid', 'epik', 'wickedid', 's_cid', 'scid', 'fb_action_ids', 'fb_action_types', 'fb_ref',
  'fb_source', 'action_object_map', 'action_type_map', 'action_ref_map', '_openstat', 'trk', 'trkcampaign', 'sc_cid',
  'ref_src', 'ref_url', 'cvid', 'mbid', 'spm', '__twitter_impression', 'at_medium', 'at_campaign', 'guccounter',
  'guce_referrer', 'guce_referrer_sig',
]);
const TRACK_PREFIX = ['utm_', 'hsa_', 'pk_', 'mtm_', 'matomo_', 'oly_', 'ga_'];

/** Share-tracking parameters that are only tracking on these sites (elsewhere they may be functional). */
const TRACK_BY_SITE: Record<string, string[]> = {
  'youtube.com': ['si', 'feature', 'pp'],
  'youtu.be': ['si', 'feature'],
  'spotify.com': ['si', 'context', 'nd'],
  'twitter.com': ['s', 't'],
  'x.com': ['s', 't'],
  'instagram.com': ['igshid', 'igsh', 'img_index'],
  'threads.net': ['xmt', 'slof'],
  'tiktok.com': ['is_from_webapp', 'sender_device', 'web_id', 'is_copy_url', 'share_app_id', 'share_link_id'],
  'linkedin.com': ['rcm', 'trackingid', 'refid', 'lipi'],
  'amazon.com': ['ref_', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_r', 'pf_rd_p', 'psc', 'content-id'],
  'reddit.com': ['share_id', 'utm_name', 'rdt'],
  'facebook.com': ['mibextid', 'rdid', 'sfnsn'],
};

function isTracking(key: string, domain: string | null): boolean {
  const k = key.toLowerCase();
  if (TRACK_EXACT.has(k) || TRACK_PREFIX.some((p) => k.startsWith(p))) return true;
  const site = domain ? TRACK_BY_SITE[domain] : undefined;
  return !!site?.includes(k);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

/**
 * Remove tracking parameters from a query string, keeping every other parameter byte for byte (no
 * re-encoding, so functional parameters are untouched). Returns the new search ('' or '?…') and the
 * removed parameter names.
 */
export function stripTracking(search: string, domain: string | null): { search: string; removed: string[] } {
  if (!search || search === '?') return { search: '', removed: [] };
  const kept: string[] = [];
  const removed: string[] = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const key = safeDecode(part.split('=')[0] ?? '');
    if (isTracking(key, domain)) { if (!removed.includes(key)) removed.push(key); } else kept.push(part);
  }
  return { search: kept.length ? `?${kept.join('&')}` : '', removed };
}

// ---------------------------------------------------------------------------------------------
// Scripts (homograph checks)

const SCRIPTS = [
  'Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi',
  'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian',
  'Hangul', 'Ethiopic', 'Cherokee', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han',
] as const;
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')] as const);

function scriptOf(ch: string): string | null {
  if (/[\p{Script=Common}\p{Script=Inherited}]/u.test(ch)) return null;
  for (const [name, re] of SCRIPT_RE) if (re.test(ch)) return name;
  return 'Other';
}

/** Script mixes that are normal in real names (Japanese, Chinese, Korean with Latin), as browsers allow. */
const ALLOWED_MIXES = [
  new Set(['Latin', 'Han', 'Hiragana', 'Katakana']),
  new Set(['Latin', 'Han', 'Bopomofo']),
  new Set(['Latin', 'Han', 'Hangul']),
];

/** Non-Latin letters that are easy to mistake for Latin ones. */
const LATIN_LOOKALIKES = new Set([...
  // Cyrillic
  'аеорсухіјѕԁԛԝһӏԍАВЕКМНОРСТХУІЈЅԜӀ' +
  // Greek
  'αοορνικτυχεβΑΒΕΗΙΚΜΝΟΡΤΥΧΖ' +
  // Armenian
  'օսոհոզ' +
  // Latin-looking letters from other blocks and Latin letters easy to misread
  'ıɑɡɩɪʏꞵⅰⅼꓲꓳ',
]);

export function labelScripts(label: string): Set<string> {
  const s = new Set<string>();
  for (const ch of label) { const sc = scriptOf(ch); if (sc) s.add(sc); }
  return s;
}

/**
 * Homograph checks for one decoded label. `asciiTld`: a label written only in look-alikes of Latin letters is
 * suspicious under a Latin top-level domain (аррӏе.com) but normal under its own script's (.рф).
 */
export function labelRisk(label: string, asciiTld = true): 'mixedScript' | 'confusable' | null {
  const scripts = labelScripts(label);
  if (scripts.size > 1 && !ALLOWED_MIXES.some((ok) => [...scripts].every((x) => ok.has(x)))) return 'mixedScript';
  const letters = [...label].filter((ch) => scriptOf(ch));
  if (letters.length && letters.some((ch) => LATIN_LOOKALIKES.has(ch))) {
    // A whole label of non-Latin lookalikes ("аррӏе") or Latin with misreadable letters ("ɡoogle").
    if (!scripts.has('Latin') && asciiTld && letters.every((ch) => LATIN_LOOKALIKES.has(ch))) return 'confusable';
    if (scripts.has('Latin')) return 'confusable';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const NAVIGABLE = new Set(['http', 'https']);

/** The registrable domain a piece of visible text claims ("PayPal.com", "https://paypal.com/login"), or null. */
export function claimedDomain(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s/@]*@)?([^\s/?#:@]+\.[^\s/?#:@]+)/i.exec(text.trim());
  if (!m || /\s/.test(text.trim())) return null;
  let host: string;
  try { host = new URL(`http://${m[1]}`).hostname; } catch { return null; }
  const p = parse(host, { allowPrivateDomains: true });
  if (p.isIp) return host;
  return p.domain && (p.isIcann || p.isPrivate) ? p.domain : null;
}

function rawHostOf(raw: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw.trim());
  if (!m) return '';
  const auth = m[1]!;
  const host = auth.slice(auth.lastIndexOf('@') + 1);
  return host.replace(/:\d*$/, '').toLowerCase();
}

export function analyzeLink(raw: string, visibleText?: string | null): LinkReport {
  let u: URL | null = null;
  try { u = new URL(raw.trim()); } catch { /* handled below */ }
  const scheme = u ? u.protocol.replace(/:$/, '').toLowerCase() : (/^([a-z][a-z0-9+.-]*):/i.exec(raw.trim())?.[1]?.toLowerCase() ?? '');
  const base: LinkReport = {
    navigable: false, scheme, original: u?.href ?? raw, openUrl: '', host: '', unicodeHost: null, domain: null, subdomain: '',
    isIp: false, port: '', removed: [], warnings: [], flagged: true,
  };
  if (!u || !NAVIGABLE.has(scheme) || !u.hostname) return base;

  const warnings: LinkWarning[] = [];
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const isIp = IPV4_RE.test(host) || host.startsWith('[');
  const p = parse(host, { allowPrivateDomains: true });
  const domain = isIp ? null : p.domain && (p.isIcann || p.isPrivate) ? p.domain : null;
  const subdomain = domain && host.length > domain.length ? host.slice(0, host.length - domain.length - 1) : '';
  const unicode = host.split('.').some((l) => l.startsWith('xn--')) ? toUnicode(host) : null;

  if (scheme === 'http') warnings.push('insecure');
  if (isIp) warnings.push('ip');
  if (u.username || u.password) warnings.push('userinfo');
  if (unicode) {
    const asciiTld = /^[a-z0-9-]+$/.test(host.split('.').pop() ?? '') && !host.split('.').pop()!.startsWith('xn--');
    const risks = unicode.split('.').map((l) => labelRisk(l, asciiTld));
    if (risks.includes('mixedScript')) warnings.push('mixedScript');
    else if (risks.includes('confusable')) warnings.push('confusable');
  }
  const claimed = claimedDomain(visibleText);
  if (claimed && claimed !== (domain ?? host)) warnings.push('mismatch');
  if (SHORTENERS.has(domain ?? '') || SHORTENERS.has(host)) warnings.push('shortener');
  if (subdomain) {
    // A familiar site name in front of another site: "paypal.com" in paypal.com.login-check.example.
    const labels = subdomain.split('.');
    for (let i = 0; i + 1 < labels.length; i++) {
      const cand = `${labels[i]}.${labels[i + 1]}`;
      const cp = parse(cand, { allowPrivateDomains: false });
      if (cp.isIcann && cp.domain === cand && cp.publicSuffix === labels[i + 1]) { warnings.push('deceptiveSubdomain'); break; }
    }
  }
  const rawHost = rawHostOf(raw);
  const pct = (u.pathname + u.search).match(/%[0-9a-f]{2}/gi)?.length ?? 0;
  const obfuscated =
    (isIp && rawHost !== '' && rawHost !== host) ||                // 0x7f.1, 2130706433, 0177.0.0.1 …
    /%[0-9a-f]{2}/i.test(rawHost) ||                               // percent-encoded host
    subdomain.split('.').filter(Boolean).length > 4 ||             // a.b.c.d.e.example.com
    (pct >= 12 && pct * 3 > (u.pathname + u.search).length * 0.4); // mostly %XX
  if (u.href.length > 300) warnings.push('long');
  if (obfuscated) warnings.push('obfuscated');
  if (u.port) warnings.push('port');

  // What is opened: tracking removed, credentials dropped (the browser would ignore or prompt for them).
  const clean = new URL(u.href);
  clean.username = '';
  clean.password = '';
  const { search, removed } = stripTracking(u.search, domain);
  const openUrl = `${clean.protocol}//${clean.host}${clean.pathname}${search}${clean.hash}`;

  return {
    navigable: true, scheme, original: u.href, openUrl, host, unicodeHost: unicode, domain, subdomain, isIp, port: u.port,
    removed, warnings, flagged: warnings.length > 0,
    ...(claimed && warnings.includes('mismatch') ? { claimed } : {}),
    ...(u.username ? { userinfo: safeDecode(u.username) + (u.password ? ':…' : '') } : {}),
  };
}

/** Schemes that are never links: rendered as plain text wherever they appear. */
export function isNavigableHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}
