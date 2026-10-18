import { NextResponse, type NextRequest } from 'next/server';
import { EMBED_FRAME_ORIGINS } from '@/lib/embeds';

// Per-request nonce + strict Content-Security-Policy (spec §7). No third-party origins
// except the project's own Supabase API/Realtime endpoints.
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isDev = process.env.NODE_ENV === 'development';
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseWs = supabase.replace(/^http/, 'ws');

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? ` 'unsafe-eval'` : ''}`,
    // Dev tooling injects un-nonced <style> tags (a nonce would make 'unsafe-inline' ignored).
    isDev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `media-src 'self' blob:`,
    `font-src 'self'`,
    `connect-src 'self' ${supabase} ${supabaseWs}`,
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
    ...(supabase.startsWith('https://') ? [`upgrade-insecure-requests`] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|sw.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
