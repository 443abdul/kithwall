// The signed mirror list (docs/v2/08-censorship.md §2). Pure functions, unit-tested in mirrors.test.ts.
//
// Published document (JSON, served from every mirror's /api/net/mirrors, GitHub raw, IPFS, …):
//   { "kithwall-mirrors": 1, "body": "<payload as a JSON string>", "sig": "<base64url Ed25519>" }
// The signature covers UTF-8("kithwall/mirror-list/v1\n" + body) (packages/crypto signed.ts) and is made
// offline by the owner with scripts/mirrors.mjs. The app only trusts a list that verifies against
// NEXT_PUBLIC_MIRROR_LIST_PUBKEY, has not expired, and is not older than the newest list it already saw
// (rollback protection: a censor replaying an old list full of dead or seized domains is refused).
//
// Payload:
//   { "format": "kithwall-mirrors", "version": 7, "issued": "2026-10-23T00:00:00Z",
//     "expires": "2027-01-23T00:00:00Z",
//     "mirrors": [ { "origin": "https://example.org", "api": "https://example.org/sb",
//                    "realtime": "wss://example.org/sb", "kind": "mirror", "label": "Mirror 1" } ],
//     "apk": [ { "url": "https://example.org/kithwall.apk", "sha256": "…" } ], "apkCert": "AB:CD:…",
//     "note": "optional short text" }
//
// Compact form for QR codes and messages: "kwm1." + base64url(UTF-8 of the published JSON).
import { b64u, verifyDocument } from '@kithwall/crypto';
import { asOrigin } from './config';

export const MIRROR_LIST_CONTEXT = 'kithwall/mirror-list/v1';
export const MIRROR_TOKEN_PREFIX = 'kwm1.';
const MAX_BODY = 32 * 1024;
const MAX_MIRRORS = 64;

export type MirrorKind = 'primary' | 'mirror' | 'onion';

export interface Mirror {
  origin: string;
  /** REST/Auth/Storage proxy for this mirror (absolute), if it has one. */
  api?: string;
  /** Realtime proxy (ws/wss, absolute), if it has one. */
  realtime?: string;
  kind: MirrorKind;
  label?: string;
}

export interface ApkLink { url: string; sha256?: string }

export interface MirrorList {
  version: number;
  issued: string;
  expires: string;
  mirrors: Mirror[];
  apk: ApkLink[];
  apkCert?: string;
  note?: string;
}

export interface SignedMirrorList { 'kithwall-mirrors': 1; body: string; sig: string }

export type VerifyResult =
  | { ok: true; list: MirrorList; signed: SignedMirrorList }
  | { ok: false; reason: 'format' | 'signature' | 'expired' | 'not-yet-valid' | 'rollback' | 'no-key' };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Accepts the published JSON (string or object), a kwm1. token, or text containing a kwm1. token. */
export function parseSigned(input: unknown): SignedMirrorList | null {
  let v: unknown = input;
  if (typeof v === 'string') {
    const s = v.trim();
    const m = /kwm1\.([A-Za-z0-9_-]+)/.exec(s);
    try {
      v = m ? JSON.parse(dec.decode(b64u.decode(m[1]!))) : JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o['kithwall-mirrors'] !== 1 || typeof o.body !== 'string' || typeof o.sig !== 'string') return null;
  if (o.body.length > MAX_BODY) return null;
  return { 'kithwall-mirrors': 1, body: o.body, sig: o.sig };
}

/** The compact share token for a signed list. */
export function toToken(s: SignedMirrorList): string {
  return MIRROR_TOKEN_PREFIX + b64u.encode(enc.encode(JSON.stringify(s)));
}

function endpoint(v: unknown, schemes: string[]): string | undefined {
  if (typeof v !== 'string' || v.length > 512) return undefined;
  try {
    const u = new URL(v);
    if (!schemes.includes(u.protocol) || u.username || u.password) return undefined;
    const plain = u.protocol === 'http:' || u.protocol === 'ws:';
    if (plain && !u.hostname.endsWith('.onion') && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** Validates the payload shape. Unknown fields are ignored; bad mirror entries are dropped. */
export function parsePayload(body: string): MirrorList | null {
  let p: unknown;
  try { p = JSON.parse(body); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (o.format !== 'kithwall-mirrors') return null;
  if (typeof o.version !== 'number' || !Number.isSafeInteger(o.version) || o.version < 1) return null;
  if (typeof o.issued !== 'string' || typeof o.expires !== 'string') return null;
  if (Number.isNaN(Date.parse(o.issued)) || Number.isNaN(Date.parse(o.expires))) return null;
  if (!Array.isArray(o.mirrors) || o.mirrors.length > MAX_MIRRORS) return null;
  const mirrors: Mirror[] = [];
  const seen = new Set<string>();
  for (const m of o.mirrors as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const origin = typeof r.origin === 'string' ? asOrigin(r.origin) : null;
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    const kind: MirrorKind = r.kind === 'primary' || r.kind === 'onion' ? r.kind : 'mirror';
    mirrors.push({
      origin,
      kind: new URL(origin).hostname.endsWith('.onion') ? 'onion' : kind,
      ...(endpoint(r.api, ['https:', 'http:']) ? { api: endpoint(r.api, ['https:', 'http:']) } : {}),
      ...(endpoint(r.realtime, ['wss:', 'ws:']) ? { realtime: endpoint(r.realtime, ['wss:', 'ws:']) } : {}),
      ...(typeof r.label === 'string' && r.label.length <= 64 ? { label: r.label } : {}),
    });
  }
  const apk: ApkLink[] = Array.isArray(o.apk)
    ? (o.apk as unknown[]).flatMap((a) => {
      const r = (a ?? {}) as Record<string, unknown>;
      const url = endpoint(r.url, ['https:']);
      if (!url) return [];
      return [{ url, ...(typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(r.sha256) ? { sha256: r.sha256.toLowerCase() } : {}) }];
    }).slice(0, 16)
    : [];
  return {
    version: o.version,
    issued: o.issued,
    expires: o.expires,
    mirrors,
    apk,
    ...(typeof o.apkCert === 'string' && /^[0-9A-Fa-f:]{64,95}$/.test(o.apkCert) ? { apkCert: o.apkCert.toUpperCase() } : {}),
    ...(typeof o.note === 'string' && o.note.length <= 280 ? { note: o.note } : {}),
  };
}

/**
 * Verify a signed mirror list.
 * @param minVersion the newest version already accepted on this device (0 = none): older lists are refused.
 * @param skewMs clock tolerance for `issued` (phones with a wrong clock are common).
 */
export function verifyMirrorList(
  input: unknown, pubkey: string, opts: { now?: number; minVersion?: number; skewMs?: number } = {},
): VerifyResult {
  if (!pubkey) return { ok: false, reason: 'no-key' };
  const signed = parseSigned(input);
  if (!signed) return { ok: false, reason: 'format' };
  if (!verifyDocument(MIRROR_LIST_CONTEXT, signed.body, signed.sig, pubkey)) return { ok: false, reason: 'signature' };
  const list = parsePayload(signed.body);
  if (!list) return { ok: false, reason: 'format' };
  const now = opts.now ?? Date.now();
  if (Date.parse(list.expires) <= now) return { ok: false, reason: 'expired' };
  if (Date.parse(list.issued) > now + (opts.skewMs ?? 24 * 3600_000)) return { ok: false, reason: 'not-yet-valid' };
  if (list.version < (opts.minVersion ?? 0)) return { ok: false, reason: 'rollback' };
  return { ok: true, list, signed };
}

/** Plain text for SMS / messengers: the addresses a person can type, plus the verifiable token. */
export function shareText(list: MirrorList, signed: SignedMirrorList | null, intro: string): string {
  const lines = [intro, ...list.mirrors.map((m) => m.origin)];
  if (signed) lines.push('', toToken(signed));
  return lines.join('\n');
}
