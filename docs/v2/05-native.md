# Kithwall 2: native apps (Android and iOS)

Status: implemented, not yet built on a device (phase 5) · 2026-10-21 · see also `00-brief.md` §8, `01-accounts.md`
(passkeys and PRF), `03-safety.md` (app PIN, duress, wipe), `04-calls.md`, `03-transparency.md` (data map)

The apps are a **Capacitor 8** shell around the deployed web app, with native code where a WebView is
not enough: passkeys with PRF, hardware-backed key storage, biometric unlock, push notifications that
only carry ciphertext, screen protection and screenshot notices.

| | Android | iOS |
|---|---|---|
| Project | `apps/mobile/android` (Java, AGP 8.13, compile/target SDK 36, **min SDK 28**) | `apps/mobile/ios/App` (Swift, SPM, **iOS 16+**) |
| Builds | flavours `play` (Google Play, FCM) and `foss` (direct APK / F-Droid, UnifiedPush, no Google libraries) | one app + Notification Service Extension |
| CI | `.github/workflows/android.yml` (APK + AAB) | `.github/workflows/ios.yml` (simulator build + unsigned archive; signing prepared) |
| Status | compiles in CI only (no JDK/SDK on the dev machine) | compiles in CI only (no Mac); needs the Apple account to run on a device |

## 1. Architecture

```
 ┌──────────── Kithwall app (com.kithwall.app) ────────────┐
 │ WebView ── loads https://www.kithwall.com (server.url) ──┼──► Vercel (Next.js, same CSP as the website)
 │   window.Capacitor (injected before page scripts, │      │
 │   outside the page CSP)                           │      │
 │ apps/web/src/lib/native/** ── isNative()? ──► plugins:   │
 │   KithwallPasskey  Credential Manager / AuthenticationServices (PRF)
 │   KithwallSecure   Keystore (StrongBox) / Keychain, BiometricPrompt / Face ID
 │   KithwallShell    navigation policy, FLAG_SECURE / app-switcher cover, screenshot events, quick exit
 │   KithwallPush     FCM | UnifiedPush | APNs registration; decrypt + show natively
 │ www/offline.html (the only bundled page: "can't connect", retry)                 │
 └──────────────────────────────────────────────────────────┘
```

- **Remote web app, one origin.** `apps/mobile/capacitor.config.ts` sets `server.url` from `KITHWALL_ENV`
  at `cap sync` time: `production` → `https://www.kithwall.com`, `staging` → `https://staging.kithwall.com`.
  Server API routes (passkey ceremonies, push dispatch, TURN, link previews, recovery) stay where they are;
  the app gets web fixes without a store release.
- **No remote code from anywhere else.** `allowNavigation` is empty. `KithwallShell.shouldOverrideLoad`
  (both platforms) lets only the origin and the bundled offline page load in the app; `https`, `http`,
  `mailto` and `tel` links open in the system browser/app; every other scheme (`intent:`, `file:`,
  `javascript:` …) is blocked. Sub-frames are still limited by the page CSP (`frame-src` = the click-to-play
  video players only).
- **CSP intact.** Android injects the bridge with `addDocumentStartJavaScript` (needs WebView ≥ 100:
  `android.minWebViewVersion`, older ones get the offline page with an "update Android System WebView"
  hint) and iOS with a `WKUserScript`; neither is subject to the page CSP, so the strict nonce CSP and
  Permissions-Policy in `src/proxy.ts` / `next.config.ts` are unchanged and apply inside the app too.
  Capacitor's request proxy (which would rewrite HTML and drop the CSP) is never used on supported WebViews.
- **Web bundle unchanged for browsers.** `lib/native/index.ts` is a tiny synchronous check of
  `window.Capacitor.isNativePlatform()`. `@capacitor/core` and every `lib/native/*` module are loaded with
  dynamic `import()` only inside the app (an ~8 kB chunk that browsers never fetch; checked in the built-in
  browser on `/signin`, `/home`, `/you/safety/*`).
- **Hardening.** Android: `usesCleartextTraffic=false`, network security config trusts system CAs only (no
  user-installed CAs), `allowBackup=false` + data-extraction rules exclude everything from cloud backup and
  device transfer, FileProvider limited to the app cache, WebView debugging off, F-Droid-friendly
  `dependenciesInfo` off. iOS: Keychain items `ThisDeviceOnly`, no backups of secrets.

### Web app integration (apps/web)

| File | What |
|---|---|
| `src/lib/native/index.ts` | `isNative()`, `nativePlatform()`, `nativePlugin(name)` (lazy `@capacitor/core` + `registerPlugin`) |
| `src/lib/native/plugins.ts` | TypeScript contracts of the four plugins (names, arguments, error codes) |
| `src/lib/native/passkey.ts` | native ceremonies → `@simplewebauthn` JSON shapes; PRF taken out before anything is sent |
| `src/lib/native/secure.ts` | Keystore/Keychain store for `lib/keys/device.ts`; biometric helpers |
| `src/lib/native/push.ts` | register / sync / disable native push, hidden-chat mirror, notification taps |
| `src/lib/native/shell.ts` | secure screen setting, screenshot events, quick exit |
| `src/lib/native/association.ts` | assetlinks / AASA bodies, Android passkey origins |
| `src/lib/push/crypto.ts` | RFC 8291 encrypt (server) + reference decrypt (tests) |
| `src/lib/push/endpoint.ts` | UnifiedPush endpoint validation and the public-address-only DNS lookup (SSRF) |
| `src/lib/push/native-server.ts` | FCM HTTP v1, UnifiedPush (Web Push), APNs senders |
| `src/lib/safety/biometric.ts` | biometric unlock (real unlock only) |
| `src/app/.well-known/assetlinks.json/route.ts`, `…/apple-app-site-association/route.ts` | association files |
| `src/components/safety/NativeProtection.tsx` | Safety centre → App lock: biometrics, screenshots (app only) |
| changed | `lib/auth/passkey-client.ts`, `lib/auth/passkey-server.ts` (Android origins), `lib/keys/device.ts`, `lib/push.ts`, `lib/safety/{wipe,swmirror,quickexit}.ts`, `components/push/PushManager.tsx`, `components/calls/CallRoot.tsx`, `components/safety/{PinLockScreen,SafetyRuntime,LockSettings,Devices}.tsx`, `app/api/push/{dispatch,test}/route.ts`, `proxy.ts` (matcher skips `/.well-known/`) |

## 2. Domain association and the passkey rpID (decision)

**Decision: the rpID stays `www.kithwall.com`** for the website and both apps (and `staging.kithwall.com` on
staging). Nothing changes for the web: production already derives rpID = `www.kithwall.com` from
`NEXT_PUBLIC_SITE_URL=https://www.kithwall.com` (no `PASSKEY_RP_ID` is set in production; staging sets
`PASSKEY_RP_ID=staging.kithwall.com`).

Why not `kithwall.com`: the apex is a **Vercel domain-level 308 redirect to `www`** (project domain
setting, applied at Vercel's edge before any route or middleware runs), so
`https://kithwall.com/.well-known/assetlinks.json` and `…/apple-app-site-association` can't be served
without a redirect, and neither Google's Digital Asset Links verifier nor Apple's CDN follow redirects. A
route-level exception isn't possible with a domain redirect. Making the apex serve content (removing the
domain redirect and redirecting in `next.config.ts` instead, except `/.well-known/*`) would work, but buys
nothing: there are no production v2 passkeys yet, so `www` costs nothing, and it keeps one canonical host.
If the rpID ever changes, every existing passkey stops working on the web and in the apps (they are bound
to the rpID); do it only before launch.

| File | Served at | Content | Config |
|---|---|---|---|
| Digital Asset Links | `https://www.kithwall.com/.well-known/assetlinks.json` | `com.kithwall.app` with `get_login_creds` (passkeys) and `handle_all_urls` (verified app links); `[]` until configured | `ANDROID_CERT_SHA256` (comma-separated SHA-256 fingerprints; `AB:CD:…` or hex) |
| Apple app-site association | `https://www.kithwall.com/.well-known/apple-app-site-association` | `webcredentials` + `applinks` for `<TEAMID>.com.kithwall.app` (not `/api/*`); **404 until configured** | `APPLE_TEAM_ID` |

Both are `application/json`, `Cache-Control: public, max-age=3600`, no redirect, outside the page CSP proxy.

**Server-side passkey verification.** Android Credential Manager puts the app's own origin in
`clientDataJSON`: `android:apk-key-hash:<base64url(SHA-256 of the signing certificate)>`. `relyingParty()`
in `lib/auth/passkey-server.ts` now accepts that origin for every fingerprint in `ANDROID_CERT_SHA256` (the
same list the assetlinks file publishes), in addition to the web origins. iOS reports
`https://<rpID>`, which is already accepted. The rpID check (`expectedRPID`) is unchanged.

## 3. Passkeys in the app

WebViews don't offer WebAuthn with PRF, so `lib/auth/passkey-client.ts` routes `createPasskey`,
`getPasskey` and `evaluatePrf` to the `KithwallPasskey` plugin when `isNative()`, with identical return
shapes (`RegistrationResponseJSON` / `AuthenticationResponseJSON` + the 32-byte PRF output), so
`account-impl.ts`, `session.ts` and the server are unchanged. The PRF input is the same `PRF_APP_SALT`
(base64url in the request JSON); the output is removed from `clientExtensionResults` before anything is
sent (unit-tested).

- **Android** (`KithwallPasskeyPlugin.java`): `androidx.credentials` 1.6.0, `CreatePublicKeyCredentialRequest`
  / `GetPublicKeyCredentialOption` with the standard WebAuthn JSON including `extensions.prf.eval.first`.
  Google Password Manager evaluates PRF (Android 9+ with Play services; the `play` build adds
  `credentials-play-services-auth`). The `foss` build relies on the Android 14+ credential-provider API
  (third-party managers such as Bitwarden, KeePassDX…); without a provider, sign-up falls back to the
  passphrase, as on browsers without PRF.
- **iOS** (`Kithwall.swift`, `KithwallPasskeyPlugin`): `ASAuthorizationPlatformPublicKeyCredentialProvider`
  with `ASAuthorizationPublicKeyCredentialPRFRegistrationInput/AssertionInput` (**iOS 18+**); iOS 16–17
  get passkeys without PRF → `prf_unsupported` → passphrase. Requires the `webcredentials` association.
- **Same passkey, same keys.** A synced passkey must give the app and the browser the same PRF output,
  or an AMK wrap made in one can't be opened in the other. Google Password Manager implements the WebAuthn
  salt hashing (`SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input)`); for Apple's native API this is **not documented**
  and must be checked on a device (see §10). Known Apple issue: PRF over hybrid (QR) was wrong on iOS
  18.0–18.3 (fixed in 18.4).

## 4. Secure key storage and biometrics

`lib/keys/device.ts` keeps three device records: the "keep me signed in" AMK (`amk`), the app-PIN record
(`pin`) and the wrong-PIN counter (`pin-attempts`). In a browser they sit in IndexedDB under a
non-extractable WebCrypto key. **In the app they move to `KithwallSecure`:**

- Android: AES-256-GCM with a non-exportable **Android Keystore** key (StrongBox when the phone has one),
  values in private SharedPreferences (`SecureBox.java`). A copy of the data directory is useless elsewhere.
- iOS: Keychain generic-password items, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (never synced or
  restored to another device).

The PIN record itself is unchanged (Argon2id wrap + duress marker, `lib/safety/pin.ts`); only its outer
protection moves from a WebCrypto key to the hardware-backed key.

**Biometric unlock** (Safety centre → App lock, app only, off by default, needs an app PIN):
`lib/safety/biometric.ts` stores a second copy of the AMK under a key that only opens after a **strong**
biometric check on every use (Android: Keystore key with `setUserAuthenticationRequired` +
`AUTH_BIOMETRIC_STRONG`, used through `BiometricPrompt.CryptoObject`; iOS: Keychain item with
`.biometryCurrentSet`). Re-enrolling fingerprints/faces invalidates it (the app turns the feature off and
says so). The lock screen shows "Unlock with biometrics" next to the PIN pad.

- **Biometrics are a real unlock only.** They never open the decoy, and the **duress PIN still works on the
  PIN pad**: under pressure, type the duress PIN. Turning the app PIN off turns biometrics off.
- Threat note (stated on the screen): someone who can force a finger or face onto the phone opens the real
  account; people at that risk should leave biometrics off and rely on the PIN + duress PIN.

**Wipe** (`lib/safety/wipe.ts`) additionally, in the app: deletes this install's push row and token,
deletes the device push key and the hidden-chat mirror, removes shown notifications and clears both
Keystore/Keychain stores (including the biometric key), then the usual IndexedDB/storage wipe.

## 5. Native push (payloads end-to-end encrypted to the device)

```
 DB trigger ─► /api/push/dispatch ─► push_plan(): targets[].subs (browsers) + targets[].native (apps)
   browsers:     Web Push (unchanged)
   fcm:          RFC 8291 aes128gcm(JSON) to the app's P-256 key ─► FCM HTTP v1 data-only {kw: b64u}
   unifiedpush:  standard Web Push (VAPID + aes128gcm) to the distributor endpoint (SSRF-guarded)
   apns:         RFC 8291 aes128gcm ─► APNs alert "You have new activity on Kithwall." + mutable-content + kw
 app:  FirebaseMessagingService / UnifiedPush PushService / Notification Service Extension
       decrypt on the device ─► hidden chat? generic text : "who + what" ─► notification
```

- **Same text as browsers.** The JSON is the `PushPayload` the service worker gets ("dan sent you a
  message", "Dan is calling", badge, in-app path); the server still never has message content.
- **Keys.** On first registration the app makes a P-256 key pair and a 16-byte auth secret (Android: in
  `SecureBox("push")`, wrapped by a Keystore key; iOS: Keychain, after-first-unlock, shared with the
  extension through the keychain access group). The public key and auth secret are registered with the
  token (`register_native_push`). UnifiedPush keys are made and kept by the connector library, which
  decrypts messages itself; the app shows only messages it reports as decrypted.
- **Providers see:** FCM/APNs: an opaque blob, its size (padded to 64-byte steps), time, and the token;
  Apple additionally the fixed generic alert text. The distributor: the same for UnifiedPush.
- **Hidden chats.** `lib/safety/swmirror.ts` also hands the salted hashes to `KithwallPush.setHidden`; the
  native code applies the service worker's rule (SHA-256(`salt:conversation`)) and shows only the generic
  text, linking to Activity.
- **On screen.** While the app is in front, message and call pushes are left to the app (Android:
  `MainActivity.isForeground`; iOS: `willPresent` returns no presentation).
- **Calls.** "is calling" pushes use a high-importance `calls` channel with the ringtone, a full-screen
  intent and `NotificationCompat.CallStyle` (Decline closes it; Answer/tap opens
  `/messages/<chat>?call=<id>`, where the app asks the caller whether it is still ringing; 45 s timeout).
  On Android 14+ without the full-screen permission it degrades to a normal heads-up notification. iOS:
  time-sensitive interruption level. WebRTC itself stays in the WebView (Android WebView, WKWebView 14.3+);
  microphone/camera permissions are requested at call time (Capacitor's WebChromeClient on Android;
  `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` on iOS).
- **Taps.** Android: the notification intent carries the path; a running app gets a retained `open` event
  (in-app navigation keeps the unlocked keys, like the service worker's `kw:navigate`), a cold start loads
  the path. iOS: `didReceive` → retained `open` event.
- **Gone devices.** FCM `UNREGISTERED`/404, APNs 410/`BadDeviceToken`/`Unregistered`, UnifiedPush 404/410
  and endpoints that resolve to non-public addresses delete the row. Token rotation needs no extra route:
  the app re-registers on the next sign-in/open (`syncPush`).

**UnifiedPush SSRF guard** (`lib/push/endpoint.ts`): endpoints must be `https`, default port, no
credentials/fragment/backslash, a real DNS name (no IP literals, no single-label, `.local`, `.internal`,
`.home.arpa`, `.onion` …), ≤ 1024 chars — checked by the database CHECK too. At send time the request uses
a custom DNS `lookup` that refuses if **any** resolved address is loopback, private, link-local, CGNAT,
multicast, reserved, IPv4-mapped/NAT64 etc. (so a DNS-rebinding answer can't slip between check and
connect); no redirects are followed; body ≤ 4 KiB; 8 s timeout.

**Database** (`supabase/migrations/20261026000100_native_push.sql`): `public.native_push_devices`
(owner select/delete only; writes through `register_native_push(provider, token, p256dh, auth, label,
apns_env)` with the same rate limit and take-over semantics as browser subscriptions; at most 20 per
person), `kw.has_push_target()`, and `kw.push_enqueue()` / `public.push_plan()` redefined to include
app-only recipients and a `native` array per target. All columns are in the data map (category
`account`; `auth` classified `hashed`). Tests: `supabase/tests/native_push.test.sql`.

**Server env** (Vercel, server-only, sensitive): `FCM_SERVICE_ACCOUNT_JSON` (raw JSON or base64),
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (PEM or base64), optional `APNS_BUNDLE_ID`. UnifiedPush
reuses the VAPID keys. Without a provider's config, those devices are skipped (counted as failed).

## 6. Screen protection and the screenshot notice

- **"Block screenshots and hide app preview"** (Safety centre → App lock, app only). Android: `FLAG_SECURE`
  (no screenshots or screen recording of Kithwall, blank preview in recent apps) and
  `setRecentsScreenshotEnabled(false)`. iOS can't block screenshots: a blur covers the app-switcher
  snapshot. The setting is stored by the app itself so it applies before the web page loads.
- **Default OFF.** The app can't know whether a person is at risk (hidden chats and duress PINs are
  deliberately not knowable from outside the encrypted vault), and blocking screenshots by default also
  blocks legitimate ones (saving a recovery hint, reporting abuse). The Safety centre tips and the setting's
  text recommend it for anyone whose phone someone else may look at or use.
- **Screenshot notice** (brief §8): iOS `userDidTakeScreenshotNotification` and screen recording
  (`UIScreen.isCaptured`); Android 14+ `registerScreenCaptureCallback`. The app shows a **local** notice
  ("Screenshot saved on this phone. Kithwall didn't tell anyone…"). **The other people in a chat are never
  notified**: a notification would be trivially bypassed (another camera, a modified client) and would give
  false assurance; the notice is education, not enforcement.
- **Quick exit** in the app hands the neutral site to the system browser; Android also removes Kithwall from
  the recent-apps list (`finishAndRemoveTask`); iOS apps can't quit themselves.

## 7. Builds, flavours and distribution

```
cd apps/mobile
npm run sync                  # writes www/ (offline page) and runs `cap sync` (production origin)
npm run sync:staging          # same for https://staging.kithwall.com
node scripts/gen-assets.mjs   # icons, adaptive icon, splash, notification icon (from the Kithwall 2 mark)
# Android (needs JDK 21 + Android SDK): cd android && ./gradlew assemblePlayRelease bundlePlayRelease assembleFossRelease
# iOS (needs a Mac + Xcode): ruby ios/scripts/add-notification-service.rb, then open ios/App/App.xcodeproj
```

- `play`: AAB for Google Play (Play App Signing) + APK. Includes Firebase Messaging (auto-init off until
  the person turns notifications on; analytics and BigQuery metrics export off in the manifest).
- `foss`: APK with **no Google libraries** (UnifiedPush connector, no Firebase, no Play services). For direct
  download from kithwall.com and F-Droid. F-Droid builds from source and signs with its own key unless the
  build is reproducible; add F-Droid's signing fingerprint to `ANDROID_CERT_SHA256` if it signs.
- Release signing comes only from CI secrets (§9); without them CI signs with a throwaway debug key.
- Version: `KITHWALL_VERSION_CODE` = CI run number, `KITHWALL_VERSION_NAME` = the `v*` tag.

**CI** (nothing runs automatically on macOS except `v*` tags):
- `android.yml`: on pushes/PRs touching `apps/mobile/**`, tags `v*`, or manually (choose production/staging).
  Node 24, Temurin 21, `npm ci`, prepare + `cap sync android`, optional `google-services.json` and upload
  keystore from secrets, `assemblePlayRelease bundlePlayRelease assembleFossRelease`, prints the signing
  certificate SHA-256 of each APK, uploads APKs + AAB (30 days).
- `ios.yml`: manual or tags. `cap sync ios`, adds the extension target, simulator build and an unsigned
  Release archive (`CODE_SIGNING_ALLOWED=NO`); signed archive + `.ipa` only when the Apple secrets exist.

## 8. Threat model deltas

- **Push providers.** Google (FCM), Apple (APNs) or the UnifiedPush distributor learn that this device gets
  a Kithwall push at a given time, its padded size and (Apple) the fixed generic text; they never see who
  or what. Before, browsers' push services learned the same about browsers. FCM tokens/installation IDs
  are Google identifiers; the `foss` build avoids Google entirely.
- **The play build contains Firebase** (Google's client library). Firebase core initialises locally at app
  start; with messaging auto-init off it should create no installation ID or token, and so not talk to
  Google about push, until the person turns notifications on (to be confirmed with a network capture on a
  device). After that it contacts Google for installation IDs and token refreshes. People who don't want
  any Google component use the `foss` APK.
- **The WebView runs the server's code.** Like the website, a malicious or compromised server could serve
  JavaScript that reads keys (`01-accounts.md` §5). The app does **not** fix this (it loads the live site);
  what it narrows: the PRF secret and the Keystore/Keychain keys never leave the platform APIs, other
  origins can never load in the app, and no other site can inject a bridge. Shipping the web bundle inside
  the app (with signed updates) would close the gap at the cost of slower fixes; noted for later.
- **Native bridge exposure.** Any script running on the origin can call the plugins (e.g. read the
  Keystore-protected AMK when "keep me signed in" is on). That is the same power it already has over
  IndexedDB in a browser; biometric-protected values still need a biometric, and nothing leaves the device
  without the page sending it.
- **Synced passkeys.** Unchanged from the web: Google Password Manager / iCloud Keychain sync the PRF
  secret; the platform account protects the keys. App and web share passkeys (same rpID).
- **Biometrics** can be coerced (§4). **Screenshots** can't be prevented on iOS, and Android `FLAG_SECURE`
  doesn't stop another camera (§6).
- **Device storage.** Hardware-backed keys make copied app data useless elsewhere, but someone with the
  unlocked phone and the app PIN, or root on it, can still read what the app can read (`03-safety.md` §8).
- **Staging bypass secret** (§10) ends up inside staging test builds: never distribute them.

## 9. Owner checklist

### Google Play (account exists)
1. **Upload keystore** (once; keep it and its passwords in a password manager + an offline backup). With
   Android Studio installed, keytool is in its bundled JDK:
   ```powershell
   & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v `
     -keystore kithwall-upload.jks -alias kithwall-upload -keyalg RSA -keysize 4096 -validity 10000 `
     -dname "CN=Kithwall, O=Kithwall"
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("kithwall-upload.jks")) | Set-Clipboard
   ```
   (Any JDK's `keytool` works too, e.g. Eclipse Temurin 21.) Never commit the `.jks` (it is git-ignored).
2. **GitHub → repository → Settings → Secrets and variables → Actions → New repository secret**:
   `ANDROID_KEYSTORE_BASE64` (the clipboard), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
   (`kithwall-upload`), `ANDROID_KEY_PASSWORD`.
3. **Firebase** (play build push): console.firebase.google.com → *Add project* "kithwall" (turn **off**
   Google Analytics) → *Add app* → Android → package `com.kithwall.app` → download `google-services.json`.
   Base64 it (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("google-services.json")) | Set-Clipboard`)
   → GitHub secret `GOOGLE_SERVICES_JSON_BASE64`. Do not commit the file.
4. **FCM service account**: Firebase → Project settings → *Service accounts* → *Generate new private key*
   (JSON). Vercel → kithwall-web → Settings → Environment Variables → `FCM_SERVICE_ACCOUNT_JSON` = the whole
   JSON (type *Sensitive*; Production, and Preview for branch `v2` if staging should push). Check that
   "Firebase Cloud Messaging API (V1)" is enabled (Project settings → Cloud Messaging).
5. Run **Actions → Android → Run workflow** (production). Download the artifact; the log step
   "Certificate fingerprints" prints the upload key's SHA-256.
6. **Play Console** → Create app "Kithwall" → upload the `play` AAB to *Internal testing*; accept **Play App
   Signing**. Then *Test and release → App integrity → App signing*: copy **both** SHA-256 fingerprints
   (App signing key certificate and Upload key certificate).
7. **Vercel env** `ANDROID_CERT_SHA256` = `<app signing SHA-256>,<upload key SHA-256>` (Production;
   the same on Preview/v2 for staging builds signed with the upload key). Redeploy, then check
   `https://www.kithwall.com/.well-known/assetlinks.json` and Google's tester:
   `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://www.kithwall.com&relation=delegate_permission/common.get_login_creds`.
8. Play Console: store listing, **Data safety** and permissions from `docs/v2/store/play-listing.md`;
   *App content → Full-screen intent* declaration ("calling app"); target audience; content rating.
9. Direct APK: publish the `foss` APK (from a tagged CI run, signed with the upload key) on kithwall.com
   with its SHA-256 checksum; consider an F-Droid submission (metadata in the F-Droid data repo; they build
   `fossRelease`).

### Apple (later, after enrolling in the Apple Developer Program)
1. Note the **Team ID** → Vercel env `APPLE_TEAM_ID` (Production) → check
   `https://www.kithwall.com/.well-known/apple-app-site-association`.
2. Certificates, IDs & Profiles: App ID `com.kithwall.app` with **Push Notifications** and **Associated
   Domains**; App ID `com.kithwall.app.NotificationService`; keychain group `com.kithwall.app.shared` is
   covered by the team prefix.
3. **APNs key** (Keys → +, Apple Push Notifications service): download the `.p8` once → Vercel env
   `APNS_KEY_P8` (PEM text or base64), `APNS_KEY_ID`, `APNS_TEAM_ID`.
4. On a Mac (or CI): run `ruby apps/mobile/ios/scripts/add-notification-service.rb` once, open the project,
   set the team, build to a device; commit the updated `project.pbxproj`.
5. For CI signing: export a distribution certificate (`.p12`) and App Store provisioning profiles for the
   app and the extension → GitHub secrets `APPLE_TEAM_ID`, `APPLE_CERTIFICATE_P12_BASE64`,
   `APPLE_CERTIFICATE_PASSWORD`, `APPLE_PROVISIONING_PROFILE_BASE64`, `APPLE_NSE_PROVISIONING_PROFILE_BASE64`.
6. App Store Connect: listing and privacy answers from `docs/v2/store/app-store.md`; export compliance.

### Staging (optional, for testing the app before launch)
- Vercel → Settings → Deployment Protection → *Protection Bypass for Automation* → create a secret →
  GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`. A manual Android/iOS run with `env = staging` puts it in
  the app's start URL so the first load sets Vercel's bypass cookie. **Internal test builds only.**
- Passkeys on staging need Google/Apple to fetch `https://staging.kithwall.com/.well-known/*`, which Vercel
  Authentication blocks (there is no per-path exception). Either turn protection off for staging while
  testing native passkeys, or test passkeys against production after launch. Everything else (push,
  biometrics, PIN, calls) works through the bypass.

## 10. Verification and open items

**Verified locally (2026-10-21):** `next typegen` + `tsc` clean (web and mobile); `eslint src` 0 errors;
`vitest run` 301 passed / 11 skipped (new: `lib/push/push.test.ts` — RFC 8291 example byte-for-byte,
reference decrypt, round trip, web-push interoperability, tampering, SSRF validation, address
classification, DNS-rebinding refusal; `lib/native/native.test.ts` — fingerprints, Android origins,
assetlinks/AASA bodies and routes, native passkey JSON conversion with PRF removal); `supabase test db`
786 tests, 18 files, including `native_push.test.sql` and the data-map completeness test; `next build`;
built app in the in-app browser: `/signin`, `/home`, `/you/safety/lock`, `/you/safety/devices` unchanged,
Capacitor chunk not loaded; `.well-known` routes return JSON / 404 as specified.

**Must be verified by CI (cannot compile here):**
- Android: `apps/mobile/android/app/build.gradle`, all of `app/src/main/java/com/kithwall/app/*.java`
  (`MainActivity`, `KithwallShellPlugin`, `KithwallPasskeyPlugin`, `KithwallSecurePlugin`,
  `KithwallPushPlugin`, `PushCallback`, `PushCrypto`, `PushStore`, `SecureBox`, `Notifier`,
  `CallActionReceiver`), `app/src/play/**` (FCM), `app/src/foss/**` (UnifiedPush 3.3.5 from Java),
  manifests and XML resources.
- iOS: `ios/App/App/Kithwall.swift`, `KithwallShared.swift`, `AppDelegate.swift`, `SceneDelegate.swift`,
  `NotificationService/NotificationService.swift`, the `project.pbxproj` edits and
  `ios/scripts/add-notification-service.rb`.

**Must be verified on devices:**
1. Android passkey sign-up/sign-in/unlock with PRF against production (after assetlinks are live), and a
   passkey made in Chrome opening the same account in the app (same PRF output).
2. iOS 18 PRF output equals Safari's for the same passkey (salt hashing, §3). If not, pre-hash the salt in
   `KithwallPasskeyPlugin` (`SHA-256("WebAuthn PRF" ‖ 0 ‖ salt)`) and re-test.
3. Push end to end on each provider, hidden chats, call ringing on a locked phone, taps.
4. Biometric enable/unlock/invalidation; PIN + duress still work; wipe clears everything.
5. WebRTC calls in both WebViews (frame encryption worker), camera/microphone prompts.

**Open items**
- Hidden-chat filtering of the app icon badge (server-computed, as on the web).
- iOS: VoIP/CallKit ringing (needs PushKit, which Apple requires to report every VoIP push as a call — not
  compatible with sending only ciphertext without a CallKit UI); today calls ring as time-sensitive alerts.
- Shipping the web bundle inside the app with signed updates (§8).
- PWA icons (`apps/web/public/icons`) still show the v1 "k"; the native assets use the Kithwall 2 mark.
- `packages/crypto` `npm run typecheck` fails on `test/reseal.test.ts` (`Buffer` with `types: []`); this
  predates phase 5 and also affects the CI typecheck step.
