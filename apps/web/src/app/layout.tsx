import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import '../styles/v2/tokens.css';
import '../styles/v2/base.css';
import '../styles/v2/components.css';
import '../styles/v2/shell.css';
import '../styles/v2/onboarding.css';
import '../styles/v2/feed.css';
import '../styles/v2/messages.css';
import '../styles/v2/circles.css';
import '../styles/v2/public.css';
import '../styles/v2/transparency.css';
import '../styles/v2/safety.css';
import '../styles/v2/ephemeral.css';
import '../styles/v2/voice.css';
import '../styles/v2/calls.css';
import '../styles/v2/install.css';
import { Providers } from '@/components/Providers';
import { CallRoot } from '@/components/calls/CallRoot';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.kithwall.com'),
  title: { default: 'Kithwall', template: '%s · Kithwall' },
  description: 'Your people. Your space. Sealed. A private, end-to-end encrypted social network for the people you actually know. No ads, no tracking.',
  applicationName: 'Kithwall',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Kithwall', statusBarStyle: 'default' },
};

// theme-color is replaced before paint by public/theme.js with the active style's chrome colour.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#fbf6f0' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the nonce makes every page dynamic so each response gets a fresh CSP nonce.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // lang/dir/data-style/data-mode are set by theme.js before first paint (hence suppressHydrationWarning).
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {/* Applies saved appearance + language before first paint (public/theme.js). */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme.js" nonce={nonce} />
      </head>
      <body>
        <Providers nonce={nonce}>{children}<CallRoot /></Providers>
      </body>
    </html>
  );
}
