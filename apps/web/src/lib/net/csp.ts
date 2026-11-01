// CSP + headers for censorship resistance (docs/v2/08-censorship.md). Pure; unit-tested in net.test.ts.
// Only origins the owner configured are ever added to connect-src. Nothing configured → nothing added.
import { type NetConfig } from './config';
import { resolveBase } from './endpoints';

const originOf = (u: string): string | null => {
  try { return new URL(u).origin; } catch { return null; }
};
const toWs = (o: string) => o.replace(/^http(s?):/i, 'ws$1:');

/**
 * Extra connect-src sources: absolute API / Realtime bases and alternates, build-time mirrors (they are
 * health-checked and their /sb proxy may be used), and absolute mirror-list URLs. Relative bases ("/sb")
 * are covered by 'self'.
 */
export function netConnectSources(c: NetConfig): string[] {
  const out = new Set<string>();
  const add = (u: string | null) => { if (u && u !== 'null') out.add(u); };
  for (const raw of [c.apiBase, ...c.apiAlternates]) {
    if (!raw || raw.startsWith('/')) continue;
    const o = originOf(resolveBase(raw, 'https://invalid.invalid'));
    add(o);
  }
  if (c.realtimeBase && !c.realtimeBase.startsWith('/')) {
    const o = originOf(c.realtimeBase.replace(/^ws(s?):/i, 'http$1:'));
    if (o) add(toWs(o));
  }
  for (const m of c.mirrorOrigins) {
    add(m);
    if (c.realtimeBase.startsWith('/')) add(toWs(m));
  }
  for (const u of c.mirrorListUrls) if (/^https:\/\//i.test(u)) add(originOf(u));
  return [...out];
}

/**
 * connect-src source for the key log's public witness (lib/kt/witness.ts): the https origin of the witnessed
 * head file, or null when there is no witness. Fetched only when the person presses "Compare with the public
 * witness"; nothing is sent to it but the request itself.
 */
export function witnessConnectSource(headUrl: string | null | undefined): string | null {
  if (!headUrl || !/^https:\/\//i.test(headUrl)) return null;
  const o = originOf(headUrl);
  return o && o !== 'null' ? o : null;
}

/** Is this request for the onion service? (Host is the .onion name, or the onion proxy says so.) */
export function isOnionRequest(host: string | null, onionHeader: string | null, c: NetConfig): boolean {
  if (!c.onionOrigin) return false;
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  return h.endsWith('.onion') || onionHeader === '1';
}

/** Onion-Location value for a page (Tor Browser offers the .onion version), or null. */
export function onionLocation(c: NetConfig, pathAndQuery: string, onion: boolean): string | null {
  if (!c.onionOrigin || onion) return null;
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : '/';
  return `${c.onionOrigin}${p}`;
}
