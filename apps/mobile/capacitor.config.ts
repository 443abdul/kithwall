// Kithwall native shell (docs/v2/05-native.md). The app loads the deployed web app from ONE origin and
// nothing else: the origin is chosen at `cap sync` time from KITHWALL_ENV (production by default).
//   npx cap sync                       → https://www.kithwall.com
//   KITHWALL_ENV=staging npx cap sync  → https://staging.kithwall.com (behind Vercel Authentication:
//                                         see "Testing against staging" in docs/v2/05-native.md; set
//                                         KITHWALL_STAGING_BYPASS to the project's "Protection Bypass for
//                                         Automation" secret so the first load sets Vercel's bypass cookie.
//                                         Local, internal test builds only: the secret ends up in the app,
//                                         so CI refuses to embed it (security review N2).)
//   KITHWALL_ENV=local npx cap sync    → http://127.0.0.1:3073 (a `next start -p 3073` build on this
//                                         computer, reached through `adb reverse tcp:3073 tcp:3073`; DEBUG
//                                         builds only: release builds refuse a non-https origin, and only the
//                                         debug network config allows cleartext to localhost). See
//                                         "Testing on the emulator" in docs/v2/05-native.md.
// Only the bundled offline page (www/offline.html) ships inside the app. No remote code is loaded from
// anywhere but the origin; other links open in the system browser (Capacitor's default navigation
// policy, tightened by the KithwallShell plugin).
import type { CapacitorConfig } from '@capacitor/cli';

const ORIGINS = {
  production: 'https://www.kithwall.com',
  staging: 'https://staging.kithwall.com',
  local: 'http://127.0.0.1:3073',
} as const;

type Env = keyof typeof ORIGINS;
const env: Env = process.env.KITHWALL_ENV === 'staging' ? 'staging' : process.env.KITHWALL_ENV === 'local' ? 'local' : 'production';
if (env === 'local' && process.env.CI) throw new Error('KITHWALL_ENV=local is for debug builds on a developer machine only.');
const origin = ORIGINS[env];
// Censorship resistance (docs/v2/08-censorship.md §2): extra https origins of the same Kithwall the app
// health-checks and switches to when the usual one is unreachable (KwNet.java). Comma-separated, e.g.
//   KITHWALL_FALLBACK_ORIGINS=https://mirror-one.example,https://mirror-two.example npx cap sync
// Mirrors from a verified signed mirror list are added at runtime too. Empty by default.
const fallbacks = (process.env.KITHWALL_FALLBACK_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, ''))
  .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s) && s !== origin);
const bypass = env === 'staging' ? process.env.KITHWALL_STAGING_BYPASS?.trim() || undefined : undefined;
// CI artifacts are downloadable by anyone once the repository is public: never bake the bypass into them.
if (bypass && process.env.CI) throw new Error('KITHWALL_STAGING_BYPASS must not be used in CI builds (the secret would ship inside a public artifact).');

const config: CapacitorConfig = {
  appId: 'com.kithwall.app',
  appName: 'Kithwall',
  webDir: 'www',
  // Plugin calls and page console messages in logcat for debug builds only.
  loggingBehavior: 'debug',
  server: {
    url: origin,
    // Same-origin navigation only: no other host is ever loaded inside the app.
    allowNavigation: [],
    // Plain http (KITHWALL_ENV=local only) is allowed by the DEBUG network security config
    // (android/app/src/debug/res/xml), never by this flag, which would turn cleartext on in release manifests.
    cleartext: false,
    errorPath: 'offline.html',
    // The start page only; server.url itself stays the bare origin (it decides what counts as "the app").
    ...(bypass ? { appStartPath: `/?x-vercel-protection-bypass=${encodeURIComponent(bypass)}&x-vercel-set-bypass-cookie=true` } : {}),
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
    // webContentsDebuggingEnabled is left to Capacitor's default: on in debug builds (chrome://inspect),
    // off in release builds.
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
    KithwallNet: { fallbacks },
    // Edge-to-edge (target SDK 36): the window insets become the page's env(safe-area-inset-*) (WebView 140+)
    // or --safe-area-inset-* values. The page always uses viewport-fit=cover, so say so up front: no layout
    // jump when the first page commits.
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
  },
};

export default config;
