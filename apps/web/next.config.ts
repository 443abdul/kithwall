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
      'interest-cohort=(), browsing-topics=(), attribution-reporting=(), private-state-token-redemption=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets several dev servers run from one checkout: NEXT_DIST_DIR=.next-a next dev -p 3001
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  transpilePackages: ['@kithwall/crypto'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
