// Kithwall native shell (docs/v2/05-native.md). The app loads the deployed web app from ONE origin and
// nothing else: the origin is chosen at `cap sync` time from KITHWALL_ENV (production by default).
//   npx cap sync                       → https://www.kithwall.com
//   KITHWALL_ENV=staging npx cap sync  → https://staging.kithwall.com (behind Vercel Authentication:
//                                         see "Testing against staging" in docs/v2/05-native.md; set
//                                         KITHWALL_STAGING_BYPASS to the project's "Protection Bypass for
//                                         Automation" secret so the first load sets Vercel's bypass cookie.
//                                         Internal test builds only: the secret ends up in the app.)
// Only the bundled offline page (www/offline.html) ships inside the app. No remote code is loaded from
// anywhere but the origin; other links open in the system browser (Capacitor's default navigation
// policy, tightened by the KithwallShell plugin).
import type { CapacitorConfig } from '@capacitor/cli';

const ORIGINS = {
  production: 'https://www.kithwall.com',
  staging: 'https://staging.kithwall.com',
} as const;

type Env = keyof typeof ORIGINS;
const env: Env = process.env.KITHWALL_ENV === 'staging' ? 'staging' : 'production';
const origin = ORIGINS[env];
const bypass = env === 'staging' ? process.env.KITHWALL_STAGING_BYPASS?.trim() : undefined;

const config: CapacitorConfig = {
  appId: 'com.kithwall.app',
  appName: 'Kithwall',
  webDir: 'www',
  loggingBehavior: 'none',
  server: {
    url: origin,
    // Same-origin navigation only: no other host is ever loaded inside the app.
    allowNavigation: [],
    cleartext: false,
    errorPath: 'offline.html',
    // The start page only; server.url itself stays the bare origin (it decides what counts as "the app").
    ...(bypass ? { appStartPath: `/?x-vercel-protection-bypass=${encodeURIComponent(bypass)}&x-vercel-set-bypass-cookie=true` } : {}),
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
    // addDocumentStartJavaScript (bridge injected outside the page, so the strict CSP stays intact)
    // needs a recent WebView; older ones get the offline page with an "update Android System WebView" hint.
    minWebViewVersion: 100,
    useLegacyBridge: false,
    resolveServiceWorkerRequests: false,
  },
  ios: {
    contentInset: 'never',
    webContentsDebuggingEnabled: false,
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    KithwallShell: { origin, env },
  },
};

export default config;
