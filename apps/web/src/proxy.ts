import { NextResponse, type NextRequest } from 'next/server';
import { EMBED_FRAME_ORIGINS } from '@/lib/embeds';
import { NET } from '@/lib/net/config';
import { isOnionRequest, netConnectSources, onionLocation } from '@/lib/net/csp';

// Per-request nonce + strict Content-Security-Policy (spec §7). No third-party origins
// except the project's own Supabase API/Realtime endpoints.
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === 'development';
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseWs = supabase.replace(/^http/, 'ws');
  // Censorship resistance (lib/net, docs/v2/08-censorship.md): configured proxy / mirror origins only;
  // empty when nothing is configured. The onion service is plain http inside Tor, so it must not upgrade.
  const netSources = netConnectSources(NET);
  const onion = isOnionRequest(request.headers.get('host'), request.headers.get('x-kithwall-onion'), NET);

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? ` 'unsafe-eval'` : ''}`,
    // Dev tooling injects un-nonced <style> tags (a nonce would make 'unsafe-inline' ignored).
    isDev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `media-src 'self' blob:`,
    `font-src 'self'`,
    `connect-src 'self' ${supabase} ${supabaseWs}${netSources.length ? ` ${netSources.join(' ')}` : ''}`,
    `worker-src 'self' blob:`,
    // Click-to-play video embeds (lib/embeds.ts EMBED_FRAME_ORIGINS): only these players, and only
    // after the viewer presses play. No other site can be framed.
    `frame-src ${EMBED_FRAME_ORIGINS.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `manifest-src 'self'`,
    // Trusted Types is not enforced yet: Next 16's Turbopack chunk loader stalls client navigation under
    // require-trusted-types-for (see docs/03-spec.md §12). XSS defence = nonce + strict-dynamic, no inline
    // HTML from users (lint: react/no-danger), React escaping.
    ...(supabase.startsWith('https://') && !onion ? [`upgrade-insecure-requests`] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Tor Browser offers the onion address when NEXT_PUBLIC_ONION_ORIGIN is set (docs/v2/08-censorship.md §4).
  const onionLoc = onionLocation(NET, request.nextUrl.pathname + request.nextUrl.search, onion);
  if (onionLoc) response.headers.set('Onion-Location', onionLoc);
  return response;
}

export const config = {
  matcher: [
    {
      // .well-known: the app-association JSON files (docs/v2/05-native.md §2) need no page CSP or nonce.
      // sb/: the optional Supabase pass-through (next.config.ts rewrites, docs/v2/08-censorship.md §1).
      // kw-health.json: the static health file the connection check fetches (lib/net/runtime.ts): no proxy work.
      source: '/((?!api|sb/|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|sw.js|kw-health\\.json|\\.well-known/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
