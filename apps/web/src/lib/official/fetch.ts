import 'server-only';
// How the automated accounts' job reads the outside world: https only, public internet addresses only (also
// after DNS and after every redirect), a size cap on the decompressed body, a deadline. An admin can add a
// source by address, so every fetch of the job goes through here (lib/net/publicAddress.ts has the rules the
// link-preview proxy uses too).
import https from 'node:https';
import type { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import zlib from 'node:zlib';
import { BlockedError, checkUrl, safeLookup } from '../net/publicAddress';

export interface Got { url: URL; type: string; body: Buffer }

export function userAgent(): string {
  let site = 'https://www.kithwall.com';
  try { if (process.env.NEXT_PUBLIC_SITE_URL) site = new URL(process.env.NEXT_PUBLIC_SITE_URL).origin; } catch { /* default */ }
  return `KithwallBot/1.0 (+${site}/help; automated public accounts)`;
}

function once(u: URL, accept: string, deadline: number, maxBytes: number): Promise<{ redirect?: string; got?: Got }> {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error('timed out'));
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = https.request({
      method: 'GET', hostname: u.hostname, path: `${u.pathname}${u.search}`,
      headers: { 'user-agent': userAgent(), accept, 'accept-encoding': 'gzip, deflate, br' },
      lookup: safeLookup as unknown as typeof dnsLookup, agent: false, servername: u.hostname,
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return done(() => resolve({ redirect: res.headers.location })); }
      if (status < 200 || status >= 300) { res.resume(); return done(() => reject(new Error(`answered ${status}`))); }
      const type = String(res.headers['content-type'] ?? '').toLowerCase().split(';')[0]!.trim();
      if (Number(res.headers['content-length'] ?? 0) > maxBytes) { res.destroy(); return done(() => reject(new Error('too large'))); }
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
      let body: NodeJS.ReadableStream = res;
      let inflater: zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | null = null;
      if (enc === 'gzip' || enc === 'x-gzip') inflater = zlib.createGunzip();
      else if (enc === 'deflate') inflater = zlib.createInflate();
      else if (enc === 'br') inflater = zlib.createBrotliDecompress();
      else if (enc !== '' && enc !== 'identity') { res.destroy(); return done(() => reject(new Error('unknown encoding'))); }
      const stop = () => { res.destroy(); inflater?.destroy(); };
      if (inflater) {
        res.on('error', () => { stop(); done(() => reject(new Error('read failed'))); });
        body = res.pipe(inflater);
      }
      const parts: Buffer[] = [];
      let size = 0;
      body.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        // The cap counts decompressed bytes, so a small compression bomb is cut off as it expands.
        if (size > maxBytes) { stop(); done(() => reject(new Error('too large'))); } else parts.push(c);
      });
      body.on('end', () => done(() => resolve({ got: { url: u, type, body: Buffer.concat(parts) } })));
      body.on('error', () => { stop(); done(() => reject(new Error('read failed'))); });
    });
    const timer = setTimeout(() => { req.destroy(); done(() => reject(new Error('timed out'))); }, left);
    req.on('error', (e) => done(() => reject(e instanceof BlockedError ? new Error('not a public address') : new Error('could not connect'))));
    req.end();
  });
}

/**
 * GET over https from a public address. `hostOk` narrows which hosts are acceptable (checked on every hop):
 * pictures, for instance, only come from their publisher's own hosts.
 */
export async function publicGet(raw: string, opts: { accept: string; maxBytes: number; timeoutMs: number; hostOk?: (host: string) => boolean }): Promise<Got> {
  const deadline = Date.now() + opts.timeoutMs;
  let u: URL;
  try { u = checkUrl(raw); } catch { throw new Error('not a public address'); }
  for (let hop = 0; hop < 5; hop++) {
    if (u.protocol !== 'https:') throw new Error('not https');
    if (opts.hostOk && !opts.hostOk(u.hostname)) throw new Error('not an allowed host');
    const r = await once(u, opts.accept, deadline, opts.maxBytes);
    if (r.got) return r.got;
    try { u = checkUrl(r.redirect ?? '', u); } catch { throw new Error('redirected to a place that is not public'); }
  }
  throw new Error('too many redirects');
}

/** The address as stored for a source: https, a public host name, no credentials, no odd port. Null if not. */
export function cleanSourceUrl(raw: string): string | null {
  try {
    const u = checkUrl(String(raw ?? '').trim());
    if (u.protocol !== 'https:' || u.toString().length > 500) return null;
    return u.toString();
  } catch { return null; }
}
