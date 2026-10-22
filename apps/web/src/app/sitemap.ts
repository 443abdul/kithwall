import type { MetadataRoute } from 'next';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.kithwall.com').replace(/\/+$/, '');

// Only the landing page is meant for search results (see app/robots.ts).
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE}/`, changeFrequency: 'monthly', priority: 1 }];
}
