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
      'camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), serial=(), bluetooth=(), ' +
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
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
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
