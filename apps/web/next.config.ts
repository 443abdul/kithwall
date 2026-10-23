import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(self), geolocation=(self), microphone=(self), payment=(), usb=(), serial=(), bluetooth=(), ' +
      'interest-cohort=(), browsing-topics=(), private-state-token-redemption=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets several dev servers run from one checkout: NEXT_DIST_DIR=.next-a next dev -p 3001
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // Local multi-user testing uses localhost and 127.0.0.1 side by side (separate sessions).
  allowedDevOrigins: ['127.0.0.1'],
  transpilePackages: ['@kithwall/crypto'],
  // AGPL-3.0 §13: the app links to the exact source of the running build (lib/source.ts). Vercel sets
  // VERCEL_GIT_COMMIT_SHA during builds; elsewhere set NEXT_PUBLIC_COMMIT_SHA yourself (or leave it empty
  // and the links point at the repository).
  env: {
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA || '',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Censorship resistance, single origin for HTTP (docs/v2/08-censorship.md §1): with KITHWALL_SB_REWRITE=1
  // this deployment forwards /sb/* (REST, Auth, Storage, Realtime's HTTP broadcast) to Supabase, so with
  // NEXT_PUBLIC_API_BASE=/sb the browser only needs this app's own hostname for them. Vercel rewrites can't
  // carry WebSockets: Realtime needs infra/cloudflare-worker or infra/proxy (NEXT_PUBLIC_REALTIME_BASE).
  // Off by default (no rewrite at all).
  async rewrites() {
    const sb = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
    if (process.env.KITHWALL_SB_REWRITE !== '1' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(sb)) return [];
    return [{ source: '/sb/:path*', destination: `${sb}/:path*` }];
  },
  // v1 ("2010") paths → their Kithwall 2 equivalents, so old links, bookmarks and queued pushes keep
  // working. Redirects run before the filesystem, so only paths that are no longer real routes are
  // listed here. Temporary (307), since a few may get their own pages later. v1 profile URLs
  // (/<username>) are handled by app/[handle] instead: a catch-all here would shadow real routes.
  async redirects() {
    const to = (source: string, destination: string) => ({ source, destination, permanent: false });
    return [
      to('/login', '/signin'),
      to('/welcome', '/join'),
      to('/invite', '/people?tab=invite'),
      to('/invite/:code', '/join?invite=:code'),
      to('/friends', '/people'),
      to('/requests', '/people?tab=requests'),
      to('/search', '/people'),
      to('/notifications', '/activity'),
      to('/menu', '/you'),
      to('/messages/inbox', '/messages'),
      to('/groups', '/circles'),
      to('/groups/:id/:rest*', '/circles/:id'),
      to('/photos', '/albums'),
      to('/photos/new', '/albums/new'),
      to('/photos/album/:id', '/albums/:id'),
      to('/photos/:id', '/albums'),
      to('/settings', '/you/settings'),
      to('/settings/profile', '/you'),
      to('/settings/account', '/you/settings/account'),
      to('/settings/privacy', '/you/settings/privacy'),
      to('/settings/security', '/you/settings/security'),
      to('/settings/:path*', '/you/settings'),
      to('/legal', '/legal/privacy'),
      to('/circles/events/:path*', '/events/:path*'),
      to('/circles/notes/:path*', '/notes/:path*'),
      // Dropped 2010 features (docs/v2/00-brief.md §4 "Dropped").
      to('/games/:path*', '/home'),
      to('/apps', '/home'),
      to('/pages/:path*', '/home'),
      to('/places/:path*', '/home'),
      to('/pokes', '/home'),
      to('/questions', '/home'),
    ];
  },
};

export default nextConfig;
