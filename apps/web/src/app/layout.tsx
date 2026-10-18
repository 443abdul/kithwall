import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './kw2010.css';
import './responsive.css';
import '../styles/mobile.css';
import { Providers } from '@/components/Providers';

export const metadata: Metadata = {
  title: { default: 'Kithwall', template: '%s | Kithwall' },
  description: 'Your 2010 social network, sealed. End-to-end encrypted. No ads. No tracking.',
  applicationName: 'Kithwall',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#3b5998' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page dynamic so each response gets a fresh CSP nonce.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body>
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
