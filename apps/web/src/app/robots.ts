import type { MetadataRoute } from 'next';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.kithwall.com').replace(/\/+$/, '');

// Crawlers may fetch pages (so they can see each page's own noindex), but only the landing page is
// indexable (app/(auth)/page.tsx) and listed in the sitemap. The API is never crawled.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
