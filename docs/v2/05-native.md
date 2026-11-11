# Kithwall 2: native apps (Android and iOS)

Status: Android built and audited on the emulator 2026-10-23 (§11); iOS not yet built · see also `00-brief.md` §8, `01-accounts.md`
(passkeys and PRF), `03-safety.md` (app PIN, duress, wipe), `04-calls.md`, `03-transparency.md` (data map)

The apps are a **Capacitor 8** shell around the deployed web app, with native code where a WebView is
not enough: passkeys with PRF, hardware-backed key storage, biometric unlock, push notifications that
only carry ciphertext, screen protection and screenshot notices.

| | Android | iOS |
|---|---|---|
| Project | `apps/mobile/android` (Java, AGP 8.13, compile/target SDK 36, **min SDK 28**) | `apps/mobile/ios/App` (Swift, SPM, **iOS 16+**) |
| Builds | flavours `play` (Google Play, FCM) and `foss` (direct APK / F-Droid, UnifiedPush, no Google libraries) | one app + Notification Service Extension |
| CI | `.github/workflows/android.yml` (APK + AAB) | `.github/workflows/ios.yml` (simulator build + unsigned archive; signing prepared) |
| Status | builds locally (JDK 21 + Android SDK, §7) and in CI; audited on the emulator (§11) | compiles in CI only (no Mac); needs the Apple account to run on a device |

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
 │   KithwallTranslate on-device translation (play: ML Kit; foss: unsupported stub), §12
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

### App frame (what a browser does that a bare WebView doesn't)

Native side: `KwActivity` (called `MainActivity` until 2.5.0; that name is now the default launcher alias,
§14), `KwWebViewClient`, `KwChromeClient`, `KwDownloads`, `KwCallService`, `KithwallShellPlugin`. Web side: `lib/native/runtime.ts`, started by `components/native/NativeRuntime.tsx` (app
only, its own chunk; browsers never load it).

| Area | Behaviour |
|---|---|
| Launch | Android 12+ system splash: the icon of the launcher entry the app was opened from (the Kithwall mark, or a disguise's icon: §14) over the page colour (light/dark); Android 9–11 (core-splashscreen, drawn from the theme alone, which can't know the entry): the page colour with no mark. Held until the first page paints (at most 4 s). Window and WebView are painted in the page colour from the first frame: no white or black flash. No splash bitmaps. |
| Edge-to-edge | Forced by target SDK 36. Capacitor's `SystemBars` turns the insets into the page's `env(safe-area-inset-*)` (WebView 140+; `--safe-area-inset-*` plus decor padding before); `initialViewportFitValueHint: 'cover'` avoids a layout jump. Status-bar icons follow the page's own light/dark mode (`data-mode`, which can differ from the system's). Pages without a top bar (sign-in, help, legal) get a page-coloured strip behind the status bar while scrolled. |
| Keyboard | The WebView is resized above the keyboard (SystemBars pads the IME inset); an open chat that was at the bottom stays there, so the newest messages stay above the composer. |
| Back | Closes the top `<dialog>` / sheet / menu / viewer first (same as Esc), then goes back in history; on Home, the signed-out start pages and during a call the app goes to the background (task kept: the call goes on, keys stay unlocked behind the app lock). A deep link with no history goes Home first. `enableOnBackInvokedCallback` is on (predictive back). |
| Offline / errors | Only connection failures and 502/503/504 show the bundled offline page ("Try again"; retries by itself when the network comes back; "Open Kit Drop" when the offline shell is kept, see Kit Drop files). Capacitor showed it for every main-frame error, so a 404 page or a navigation the WebView aborted itself replaced a working page with "can't connect". |
| Links | Same origin loads in the app; https/mailto/tel open in the system; everything else is blocked (unchanged). |
| Files | `<input type=file>` for photos/videos opens the Android 13+ system photo picker (no storage permission); other types and `capture` keep Capacitor's Files picker / camera. Every picked file is copied to the app cache and handed over through our FileProvider: a picker URI read later (when the page encrypts and uploads it) failed with `NotReadableError`, so previews broke and sending failed. Copies older than a day are deleted; the panic wipe deletes them all. |
| Downloads | A WebView ignores `<a download href="blob:…">`. The runtime keeps the blob behind every object URL (the page CSP doesn't allow `fetch(blob:)`) and streams it in 768 KiB chunks to `KithwallShell.download*`, which writes it to **Downloads** through MediaStore (Android 10+, no permission; Android 9: share sheet) and shows "Saved to Downloads: …". Covers the data export, `.ics`, photo/video downloads. Same-origin attachment URLs go to DownloadManager with the session cookie. |
| Share | Android WebView has no `navigator.share`; the app provides it and opens the system share sheet (https links only). |
| Kit Drop files | `.kwd` files open in Kithwall from the share sheet (`ACTION_SEND`) and "Open with" in Files / Downloads / Quick Share (`ACTION_VIEW`): intent filters for `application/vnd.kithwall.kitdrop+json` (what the app saves them as) and, because senders type a `.kwd` by its unknown extension, `application/octet-stream` and `application/json` with a content check (a JSON object naming itself `kithwall-kitdrop`; otherwise "That isn't a Kit Drop file"). `KwKitDrop` copies the file (≤ 16 MB, content URIs only) into the app cache (`kitdrop/`) and opens `/you/kitdrop?incoming=<id>`: cold start loads it, warm start navigates in the page; the page reads the copy in 768 KiB base64 chunks (`KithwallShell.kitdropPending/Read/Done`, `lib/native/kitdrop.ts`), verifies and opens it as usual, then the copy is deleted (also by the panic wipe). Offline: the bundled offline page offers "Open Kit Drop" when the origin's service worker keeps the offline shell (`setOfflineShell`, docs/v2/08-censorship.md §5.1); a file opened while that page is up goes straight to the shell. |
| Calls | `lib/native/calls.ts` (`nativeCallActive({speaker, video})`, `nativeCallEnded()`) → `KithwallShell.setCallAudio`: screen kept on, `MODE_IN_COMMUNICATION`, volume keys control call volume, speaker / earpiece (a headset wins), and a "Kithwall call in progress" **foreground service** (type `microphone`, plus `camera` for video) so the microphone and camera keep working when the person switches app (Android silences them in the background). Until the call UI calls these itself, the runtime follows the call screen being shown (speaker on). |
| Plugins | `nativePlugin()` returned Capacitor's plugin proxy from an `async` function; the proxy answers every property, `then` included, so awaiting it called a native `then()` that rejected and the promise never settled: **every plugin call hung** (passkeys, Keystore storage, biometrics, push, screen protection). Fixed with a `then`-less view (`notThenable`, unit-tested). |
| Passkeys | If the password manager refuses the rpID for this app (assetlinks.json doesn't list the signing key yet, e.g. `ANDROID_CERT_SHA256` unset), the plugin reports `not_linked` (and "no create options", no password manager will save one, reports `unsupported`); the web flows treat both like "no passkeys here": the passphrase is offered, and after a v1 sign-in "Add passkey" says passkeys aren't available instead of "Something went wrong". |
| Push (foss) | Without a UnifiedPush distributor app, turning notifications on explains what to install (native dialog linking to the distributor list) instead of "Check your browser settings". |
| Release | R8 (`minifyEnabled`, `shrinkResources`, `proguard-android-optimize`; Capacitor and AndroidX ship their keep rules): foss APK 15 MB → 1.6 MB, play 2.5 MB. A release build refuses a plain-http (local) origin. Debug builds: WebView debugging on (chrome://inspect), plugin calls and page console in logcat. |

### Web app integration (apps/web)

| File | What |
|---|---|
| `src/lib/native/index.ts` | `isNative()`, `nativePlatform()`, `nativePlugin(name)` (lazy `@capacitor/core` + `registerPlugin`) |
| `src/lib/native/plugins.ts` | TypeScript contracts of the four plugins (names, arguments, error codes) |
| `src/lib/native/passkey.ts` | native ceremonies → `@simplewebauthn` JSON shapes; PRF taken out before anything is sent |
| `src/lib/native/secure.ts` | Keystore/Keychain store for `lib/keys/device.ts`; biometric helpers |
| `src/lib/native/push.ts` | register / sync / disable native push, hidden-chat mirror, notification taps |
| `src/lib/native/shell.ts` | secure screen setting, screenshot events, quick exit |
| `src/lib/native/runtime.ts` | app frame: Back, downloads, share, status-bar colour and strip, chat-at-bottom, call fallback |
| `src/lib/native/calls.ts` | `nativeCallActive({speaker, video})` / `nativeCallEnded()` for the call UI |
| `src/lib/translate/*`, `src/components/translate/*` | on-device translation (§12): engine choice, detection, in-memory cache, "Translate" action, Settings → Translation |
| `src/lib/native/kitdrop.ts` | reads a Kit Drop file handed to the app (`KwKitDrop.java`) for the Kit Drop page |
| `src/components/native/NativeRuntime.tsx` | starts the runtime inside the app (mounted in `components/Providers.tsx`) |
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
Keystore/Keychain stores (including the biometric key), then the usual IndexedDB/storage wipe, and finally the
WebView's own data through `KithwallShell.clearWebData` (cookies, every origin's storage, HTTP cache, history;
security review N6: before this the comment claimed it but nothing cleared them).

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
- **Calls.** "is calling" pushes use a high-importance `calls` channel with a repeating ringtone,
  `NotificationCompat.CallStyle` and a full-screen intent to `IncomingCallActivity` (a bare native screen
  over the lock screen: "Incoming call" only while the phone is locked, the caller's name once unlocked).
  Answer unlocks first and opens `/messages/<chat>?call=<id>&answer=1` (the page accepts the call's ring
  without a second tap); Decline stops ringing and, with the page running, sends the sealed decline; tap
  opens the chat (the page asks the caller whether it is still ringing). It stops when the page stops
  ringing for that call (`KithwallPush.cancelCall`) or at the caller's 45 s (`ts` in the payload). Details
  and limits: `04-calls.md` §14.3. On Android 14+ without the full-screen permission it degrades to a
  heads-up notification with Decline / Answer. iOS:
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
                              # (debug only: KITHWALL_ENV=local, see "Testing on the emulator" below)
node scripts/gen-assets.mjs   # icons, adaptive icon, splash, notification icon (from the Kithwall 2 mark)
# Android (needs JDK 21 + Android SDK): cd android && ./gradlew assemblePlayRelease bundlePlayRelease assembleFossRelease
# iOS (needs a Mac + Xcode): ruby ios/scripts/add-notification-service.rb, then open ios/App/App.xcodeproj
```

- `play`: AAB for Google Play (Play App Signing) + APK. Includes Firebase Messaging (auto-init off until
  the person turns notifications on; analytics and BigQuery metrics export off in the manifest).
- `foss`: APK with **no Google libraries** (UnifiedPush connector, no Firebase, no Play services). For direct
  download from kithwall.com and F-Droid. F-Droid builds from source and signs with its own key unless the
  build is reproducible; add F-Droid's signing fingerprint to `ANDROID_CERT_SHA256` if it signs.
- Release signing comes only from CI secrets (§9). Without them, branch and PR builds sign with a throwaway
  debug key (`KITHWALL_ALLOW_DEBUG_SIGNING=true`, set by CI); a version-tag build fails, and so does a local
  release build unless you set that variable (security review L14). The Gradle wrapper checks the
  distribution's SHA-256 and CI runs `wrapper-validation`; all actions are pinned to commit SHAs (L13).
- Version: `KITHWALL_VERSION_CODE` = CI run number, `KITHWALL_VERSION_NAME` = the `v*` tag.
- **JDK 21.** Gradle 8.14 can't run on Java 25, which Android Studio's bundled JBR now is ("Unsupported class
  file major version 69"): point `JAVA_HOME` at a JDK 21 (e.g. Eclipse Temurin 21, as in CI).
- **16 KB pages** (Android 15+ requirement for new apps): foss has no native libraries; play has only
  `libdatastore_shared_counter.so` (AndroidX DataStore, via Firebase), 16 KB-aligned
  (`zipalign -c -P 16 -v 4 app-play-release.apk` passes, ELF LOAD alignment 0x4000). Check again when
  dependencies change.

**Testing on the emulator** (signed-in flows against a local build; debug builds only):
```
# web: a production build using the local Supabase from apps/web/.env.local, on port 3073
cd apps/web && NEXT_DIST_DIR=.next-android NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3073 npx next build
NEXT_DIST_DIR=.next-android npx next start -p 3073
# app: debug build loading http://127.0.0.1:3073 (cleartext allowed only by src/debug/res/xml)
cd apps/mobile && KITHWALL_ENV=local node scripts/prepare.mjs && KITHWALL_ENV=local npx cap sync android
cd android && ./gradlew assembleFossDebug && adb install -r app/build/outputs/apk/foss/debug/app-foss-debug.apk
adb reverse tcp:3073 tcp:3073 && adb reverse tcp:64321 tcp:64321   # 127.0.0.1 in the emulator = this PC
# WebView devtools: chrome://inspect, or adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# afterwards: npm run sync (production) before any release build, and delete apps/web/.next-android
```
Use `127.0.0.1`: `localhost` is claimed by Capacitor's local server, and `10.0.2.2` is not a secure context
(no WebCrypto).

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
  Keystore-protected AMK when "keep me signed in" is on). Only the TOP frame of the app's origin can: Android's
  bridge is main-frame/app-origin only, and on iOS `KithwallBridgeViewController` swaps Capacitor's `bridge`
  message handler (registered for every frame) for a gate that drops messages from iframes or other origins
  (security review N1: a click-to-play embed's scripts could otherwise post plugin calls). That is the same power it already has over
  IndexedDB in a browser; biometric-protected values still need a biometric, and nothing leaves the device
  without the page sending it.
- **Synced passkeys.** Unchanged from the web: Google Password Manager / iCloud Keychain sync the PRF
  secret; the platform account protects the keys. App and web share passkeys (same rpID).
- **Biometrics** can be coerced (§4). **Screenshots** can't be prevented on iOS, and Android `FLAG_SECURE`
  doesn't stop another camera (§6).
- **Device storage.** Hardware-backed keys make copied app data useless elsewhere, but someone with the
  unlocked phone and the app PIN, or root on it, can still read what the app can read (`03-safety.md` §8).
- **Staging bypass secret** (§10) ends up inside staging test builds made with it: never distribute them. CI
  never embeds it (`capacitor.config.ts` refuses when `CI` is set), because CI artifacts become public with
  the repository (security review N2).

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
   *App content → Full-screen intent* declaration ("calling app"); *App content → Foreground service
   permissions*: `FOREGROUND_SERVICE_MICROPHONE` / `FOREGROUND_SERVICE_CAMERA`, use "ongoing call
   (user-initiated)", with a short video of a call continuing while switching apps; target audience; content
   rating. Until step 7 is done, passkeys in the app fail gracefully (the passphrase is offered): expected.
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
  `KITHWALL_STAGING_BYPASS` in your shell for a **local** build (`KITHWALL_ENV=staging npx cap sync`): it goes
  into the app's start URL so the first load sets Vercel's bypass cookie. **Internal test builds only, never
  from CI** (their artifacts are downloadable once the repository is public; security review N2). CI staging
  builds load staging without it. Don't keep the secret as a GitHub secret.
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

**Emulator audit:** see §11.

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

## 11. Emulator audit (2026-10-23)

Pixel-class AVD, Android 16 (API 37), WebView 145; the foss debug build against a local production build
(§7, "Testing on the emulator"), the foss release (R8) build against www.kithwall.com. Screenshots:
`docs/v2/screens/android-*.png`.

| Found | Severity | Now |
|---|---|---|
| Every native plugin call hung (`"X.then()" is not implemented on android`): passkeys, Keystore storage, biometrics, push, screen protection. Visible as: **v1 email + password sign-in spinning forever** (it stores the "keep me signed in" key in the Keystore), same for passphrase sign-in | critical | fixed (`notThenable`), regression test `lib/native/plugin-proxy.test.ts`; verified v1 sign-in → passkey offer → Home in the app and in desktop Chromium, and: passkey error shown, notification permission + register, downloads, call audio |
| Back always quit the app (no handler: page and unlocked keys gone) | high | menus/dialogs close first, then history; Home → background (`android-back-menu.png`, `android-back-dialog.png`) |
| Any main-frame error (404, aborted navigation) showed "Kithwall can't connect" | high | only connection failures and 502–504 (`android-offline.png`, `android-404.png`) |
| Picked photos unreadable later: broken preview, sending failed | high | copied to cache + FileProvider; system photo picker on 13+ (`android-attach.png`) |
| Downloads (export, .ics, photos, videos) did nothing | high | saved to Downloads (3 MiB test file, byte count exact) |
| Microphone silenced when leaving the app during a call; screen turned off; media audio mode | high | foreground service + call audio mode + keep-screen-on (checked with dumpsys) (`android-call.png`) |
| Splash: stretched bitmap, then a blank frame | medium | system splash on the page colour, held until first paint (`android-splash.png`, `android-splash-dark.png`) |
| Keyboard hid the newest chat messages | medium | chat stays at the bottom (`android-keyboard.png`) |
| Status-bar icons followed the system, not the page's light/dark choice; content scrolled under the clock | medium | follow `data-mode`; strip behind the status bar (`android-statusbar.png`, `android-scrim.png`) |
| `navigator.share` missing (the invite card had no Share button) | medium | system share sheet (`android-share.png`) |
| foss without a UnifiedPush app: "Check your browser settings" | medium | native explanation + link |
| Release builds not minified (15 MB) | low | R8 + resource shrinking (1.6 MB foss) |
| No WebView debugging or logs in debug builds | low (dev) | on in debug builds only |

Checked and fine: adaptive + monochrome launcher icon; notification permission asked from the in-app card,
not at start (`android-notification-permission.png`); microphone permission at the first voice note and
recording (`android-voice-note.png`); external links open in the browser; the PWA install prompt doesn't show
in the app; safe areas (status and gesture bar); dark mode.

Not verifiable on the emulator: passkeys with PRF (needs assetlinks + a signed build, §9), FCM push (needs
Firebase), UnifiedPush delivery (needs a distributor app), biometrics, a call with a second person, Android
9–12. The emulator was heavily CPU/RAM-starved (7 GB host), so timings measured there say nothing about
real phones.

Web issues seen in the app, outside this audit's files: "You is calling…" on the caller's chat entry
(calls), the language picker lists "English" twice, `no_credential` (no passkey on this phone) reads "The
passkey request was cancelled".

## 12. On-device translation (roadmap C1, 2026-11-01)

"Translate" under posts, comments and chat messages written in another language than the reader's UI
language. Text is only ever handed to an on-device model: nothing is sent to Kithwall or anyone else for
translation, and there is no cloud fallback.

| Where | Engine | Models |
|---|---|---|
| Desktop Chrome 138+ (and other browsers that ship both APIs) | built-in `Translator` + `LanguageDetector` | the browser downloads them itself, only from a tap (user activation); Kithwall asks first. Chrome has no Urdu model yet, so Urdu pairs are simply not offered there |
| Android app, `play` | `KithwallTranslate` → `TranslateImpl` (src/play): ML Kit Translation 17.0.3 + bundled Language Identification 17.0.6 | language id is inside the app; translation packs (~30 MB per language, English is the pivot) are downloaded from Google only after the person agreed, "Wi-Fi only" by default (Data Saver and mobile data are pointed out) |
| Android app, `foss`; iOS; other browsers | none: `TranslateImpl` (src/foss) answers `supported: false` | the action and the settings section are hidden |

- **Web side.** `lib/translate/engines.ts` (engine selection, browser + native adapters; `availability()` that
  never answers is treated as unavailable after 5 s, seen in an Electron-based Chromium), `core.ts` (lazy
  detection when the text nears the screen, at most two at a time; offer only for confident detections of
  ≥ 12 letters in another language and a supported pair; download planning; line-by-line translation; LRU
  caches in memory only, cleared on lock), `languages.ts` (tags, romanised `*-Latn` results are not offered,
  a script check that offers "Translate" for e.g. Arabic-script text while the browser's detector still needs
  its download), `index.ts` (per-device prefs `kw.translate` / `kw.translate.intro` in localStorage).
  Unit tests: `lib/translate/translate.test.ts`.
- **First use** explains that translation happens on the device (dialog, once per device). **Settings →
  Translation** (on the settings index, under Language): "Offer translation" and, in the app, the downloaded
  packs with Remove.
- **Google's view (play build).** Downloading a pack tells Google which language pack this phone fetched.
  ML Kit also logs usage metrics (detected/translated languages, input sizes, device model) through
  datatransport ("Firelog"); the play manifest removes datatransport's only uploader (the CCT backend), so
  queued events are deleted instead of sent (transport-runtime 3.1.9 `Uploader`: "Unknown backend …,
  deleting event batch"). This also stops the Firebase Messaging client's own Firelog events; push delivery
  doesn't use it. To confirm with a network capture on a device.
- **Size.** ML Kit adds native code to the play build: `libtranslate_jni.so` ~16 MB and
  `liblanguage_id_l2c_jni.so` ~1 MB per ABI (Play delivers one ABI per device from the AAB). All 16 KB
  aligned (zipalign `-P 16` and ELF LOAD alignment 0x4000 checked on the debug APK).
- **Not verified on a device yet:** pack download (Wi-Fi only and mobile data), translation quality for Urdu,
  removing a pack, and the telemetry block (network capture).

## 13. Release-only bugs of 2.0.0 to 2.3.0 and the release check (2026-11-11)

Three faults reached testers because every test until then ran a debug build, or a release build that was
never exercised on a device. All three are reproduced and fixed against a release build on an emulator.

1. **"Turn on notifications" waited forever and never showed Android's dialog.** `KithwallPushPlugin`
   asked through Capacitor's `requestPermissionForAlias()`, which reads the permission list from the
   `@CapacitorPlugin(permissions = {@Permission(...)})` annotation. Capacitor's shrink rules keep the
   annotated classes and methods but not the annotation types, and R8 dropped the nested `@Permission`
   values in release builds: the list was empty, Capacitor requested nothing and never answered the call
   (its `checkPermissions()` returned nothing for the same reason). Debug builds were fine. Fixes: the plugin
   has its own `ActivityResultLauncher` and no longer depends on the annotation; every request is answered
   (a watchdog covers "no dialog and no result"); `proguard-rules.pro` keeps `com.getcapacitor.annotation.**`;
   `permission()` reports `api: 2`, and the page never calls `requestPermission()` on older builds (it opens
   the notification settings instead: `lib/native/push.ts`).
   "Blocked" (Android refused without asking) is decided from the rationale flag before and after the request,
   not from timing: on a slow device Android took 3 s to refuse by itself.
2. **After a lost connection the app went to `http://127.0.0.1:3073` and stayed broken.** `www/offline.html`
   is generated (`scripts/prepare.mjs`) and git-ignored; a copy generated for `KITHWALL_ENV=local` emulator
   testing was still there when 2.1.0 to 2.3.0 were built with `cap sync` alone. Its "Try again" link and its
   `online` handler pointed at the developer address. Fix: `app/build.gradle` now refuses any release build
   whose bundled `offline.html` / `index.html` is not for the build's own https origin. Always `npm run sync`
   (never bare `cap sync`) before a release build.
   Also new: while the offline page is showing, the app health-checks the active origin every 4 s and reloads
   the page that failed (`KwWebViewClient.watchForConnection`); the page's single `online` retry often fired
   before the network worked and then never again.
3. **Play's "Automatic protection" blocks the app wherever Play can't vouch for the install.** Play adds
   `com.pairip.licensecheck` to the builds it delivers. On a device without a working Play Store, or for an APK
   downloaded from GitHub Releases and installed by hand, the app shows "Something went wrong. Check that
   Google Play is enabled on your device…" and never opens. That defeats the direct-download route
   (docs/v2/08-censorship.md §6). It must be switched off in Play Console (Test and release → App integrity →
   Automatic protection) before the next upload; it is applied when Play processes a bundle.

### The release check

`scripts/verify-release.mjs <apk>` drives a release APK on an Android 13+ device or emulator through the
WebView's DevTools socket and `adb`: annotations survived R8, the dialog shows, "Don't allow" twice, the
silent refusal is reported as blocked, "Allow", a push token is issued, the offline page belongs to the
build's origin, and the app returns by itself when the connection is back. It needs a release build with
`android.webContentsDebuggingEnabled: true` patched into the synced `capacitor.config.json` (a test build,
never uploaded). Run it before every Play upload; a release is not "verified" on a compile check.

## 14. Disguised app icon and the app's own crash reports (2026-11-11, app 2.5.0)

Web side and the wording people see: `03-safety.md` §13 (icon), `03-transparency.md` §6 (crash reports).
**Compiled here (`compilePlayDebugJavaWithJavac`, `compileFossDebugJavaWithJavac`, resources and manifest
merged for both flavours); not run on a device yet.** The steps at the end of this section are the device check.

### 14.1 Launcher entries

The activity class is now **`KwActivity`** and has no intent filter of its own. The launcher entries are
`<activity-alias>` elements that point at it (`AndroidManifest.xml`, `KwIcons.java`):

| Web id | Component | Label | Icon | In the manifest |
|---|---|---|---|---|
| `kithwall` | `com.kithwall.app.MainActivity` | Kithwall | `@mipmap/ic_launcher` | enabled |
| `calculator` | `com.kithwall.app.IconCalculator` | Calculator | `@mipmap/ic_alt_calculator` | disabled |
| `notes` | `com.kithwall.app.IconNotes` | Notes | `@mipmap/ic_alt_notes` | disabled |
| `weather` | `com.kithwall.app.IconWeather` | Weather | `@mipmap/ic_alt_weather` | disabled |

- **Existing icons survive the update.** Every home-screen icon made by 2.0.0 to 2.4.x points at the
  component `com.kithwall.app.MainActivity`. That name is kept, as the default alias, enabled. It must never
  be renamed or disabled in the manifest.
- **Every alias carries all the filters**: launcher, the verified app links (`autoVerify`, `${kwHost}`), and
  the Kit Drop "Open with" / share filters. So links, Kit Drop files and share targets work whichever entry
  is switched on, and a chooser shows that entry's name and icon. `KwActivity.pathFrom()` is unchanged (it
  reads the intent, not the component).
- **Code that opens the app addresses the class**, not an alias: `Notifier.openActivityIntent` (notification
  taps, the Answer button of `IncomingCallActivity`), `KwCallService` ("tap to return to the call"). They
  work whichever alias is enabled. `KwActivity` stays exported as `MainActivity` was (the per-install intent
  token of security review L15 still guards `kw_url`). The passkey plugin, `CallActionReceiver`, the push
  services and `KwKitDrop` never named the activity class. `KithwallPushPlugin` and `KwWebViewClient` use
  `KwActivity.isForeground()`.
- **Switching** (`KithwallShell.getAppIcon` / `setAppIcon`, `KwIcons.set`): the chosen alias is enabled and
  the others disabled with `PackageManager.DONT_KILL_APP` (one `setComponentEnabledSettings` call on Android
  13+). The plugin answers first and switches 1.2 s later, because Android removes the running task when the
  alias it was started from is disabled: the app usually closes once. Android itself remembers the choice:
  it survives app updates, restarts and the panic wipe (`clearWebData` deliberately leaves it alone).
- **Recent apps** shows the chosen entry's name and icon however the task was started
  (`KwIcons.applyTaskDescription` in `KwActivity.onCreate` and after a switch).
- **Splash.** See the Launch row in §1: on Android 12+ `android:windowSplashScreenAnimatedIcon` is `@null`
  (`res/values-v31/styles.xml`), so the system draws the tapped entry's icon; on 9–11 the splash shows no
  mark. Before this, a disguised entry would have opened with the Kithwall mark for up to 4 seconds.
- **Icons and names.** `scripts/gen-assets.mjs` draws the three disguises (original glyphs; legacy, round,
  adaptive foreground and monochrome layers; background colours in `values/ic_launcher_background.xml`).
  The labels are translated in `res/values-<language>/strings.xml` for the app's 11 other languages
  (machine-drafted, the usual names of such apps).
- **What still says Kithwall**: Settings → Apps and the app-info screen (the application label), the
  notification header and small icon, the "call in progress" notification, the incoming-call screen while
  the phone is locked, the UnifiedPush dialog of the foss build. The web screen states the first two groups.
- **R8.** Nothing here is found by reflection: the aliases and `KwApp` are named in the manifest (AAPT keeps
  them), the new plugin methods are `@PluginMethod`s (Capacitor's rules keep them). No keep rule was needed
  for the icon. `cap doctor` now reports "Missing main `<activity>`" because it only looks for a launcher
  filter on an `<activity>`; `cap sync`, `npm run sync` and the Gradle build are not affected.

### 14.2 The app's own crashes

`KwApp` (the new `Application` class) installs `KwCrash` before anything else runs. While the person has
"Send crash reports" on (the page tells the app through `KithwallShell.setCrashReports`; off by default),
an uncaught Java exception on any thread is written to `files/kw-crash.json`: the exception's class name,
its stack frames and those of its root cause, and the app version. **Never the exception message.** The
previous handler then runs, so the app still stops as Android expects. On the next start the page fetches it
(`pendingCrash`), builds a report of kind `native`, scrubs it like every other report, sends it and calls
`clearCrash`. The panic wipe removes the file and the setting (`KwCrash.forget`).

**R8:** `proguard-rules.pro` now has `-keepattributes SourceFile,LineNumberTable` and
`-keepnames class com.kithwall.app.** { *; }`, so a release build's stack names the app's own classes,
methods and lines (the app is open source; shrinking and optimisation stay on, libraries are still renamed).
Without these two rules a release crash report would be unreadable; they are the only rules this feature needs.

### 14.3 Device check (run on an emulator or phone; not done yet)

Build and install as in §7 "Testing on the emulator" (foss debug against a local build), signed in with a
test account. For the release check, repeat steps 1 to 9 and 14 to 16 with a release build (`assembleFossRelease`
with `KITHWALL_ALLOW_DEBUG_SIGNING=true`, production origin).

Upgrade and default entry
1. Install the **previous** build (2.4.x), put its icon on the home screen, sign in. Install the new build
   over it (`adb install -r`). Expect: the same home-screen icon is still there and opens the app; still signed in.
2. `adb shell cmd package query-activities -a android.intent.action.MAIN -c android.intent.category.LAUNCHER --components com.kithwall.app`
   Expect exactly one line: `com.kithwall.app/.MainActivity`.

Switching
3. Kithwall → You → Safety centre → App lock → scroll to **App icon**. Expect four choices, "Kithwall" marked
   "In use", and the "What this does not hide" box.
4. Tap **Calculator** → **Change icon**. Expect: a toast, then within a few seconds the app closes (or stays;
   both are fine) and the launcher shows a slate icon with a calculator named "Calculator"; no Kithwall icon.
   Some launchers remove the home-screen shortcut: then find "Calculator" in the app drawer.
5. Repeat the command of step 2. Expect exactly `com.kithwall.app/.IconCalculator`.
6. Open "Calculator". Expect on Android 12+: the splash shows the calculator icon on the page colour (never
   the Kithwall mark); then Kithwall opens (app PIN first if set). Recent apps shows "Calculator" with the
   calculator icon.
7. App lock → App icon shows "Calculator" as "In use". Switch to **Notes**, then **Weather**, then back to
   **Kithwall**; after each, steps 5 and 6 with the matching name. Back on Kithwall: `.MainActivity` again.

Everything else still works while disguised (do these with **Notes** switched on)
8. Notification tap: from another account send a message; tap the notification. Expect the chat opens (in the
   running app without a reload; from a cold start after the PIN). The notification itself still says Kithwall.
9. Deep link: `adb shell am start -a android.intent.action.VIEW -d "https://www.kithwall.com/you/safety"`
   (production build with verified links; on a local debug build use the host of that build). Expect Kithwall
   opens that page, or the chooser lists "Notes" with the notes icon.
10. Kit Drop "Open with": save a `.kwd` file from You → Kit Drop, then open it from the Files app. Expect "Notes"
    is offered and the Kit Drop page opens with the file. Then share a `.kwd` from Files → share sheet → "Notes".
11. Incoming call from a second account with the phone locked: the call screen shows, Answer unlocks and opens
    the call. Decline works from the notification.
12. During a call, switch to another app and tap the "call in progress" notification. Expect back in the call.
13. Passkey sign-in (only on a build whose signing key is in assetlinks.json): unchanged.

Wipe and duress
14. With **Calculator** on: Safety centre → **Wipe this device**. Expect the usual wipe; the launcher still
    shows "Calculator" (not Kithwall); opening it shows the signed-out start page.
15. Set an app PIN and a duress PIN with "wipe this device"; lock; enter the duress PIN. Expect the decoy, the
    device wiped behind it, and the launcher icon unchanged.

The app's own crash report
16. Settings → Your data → turn **Send crash reports** on. Then crash the app's own process by its id: `adb shell am crash $(adb shell pidof com.kithwall.app)`
    (`am crash com.kithwall.app` may crash the WebView's renderer process instead, which records nothing).
    Expect the app stops. `adb shell run-as com.kithwall.app ls files` (debug build) lists `kw-crash.json`;
    `adb shell run-as com.kithwall.app cat files/kw-crash.json` shows a class name and `at …` frames and
    **no message text**.
17. Open the app again. Expect within a few seconds one new row in `/mod` → Admin → Crash reports with kind
    `native`, platform `android`, the app's version and frames like
    `at android.app.ActivityThread…` / `at com.kithwall.app…`; and `kw-crash.json` is gone. Settings → Your
    data → "See what gets sent" shows that report.
18. Turn the setting off, crash again (`am crash <pid>`), reopen. Expect no `kw-crash.json` and no new row.
19. Release build only: the frames of step 17 name `com.kithwall.app.*` classes with file and line (the two
    R8 rules of §14.2 worked).

### 14.4 Verified on a device (2026-11-11)

`scripts/verify-release.mjs` now also covers the app icon and crash capture, on an Android 15 emulator with a
release build: one launcher entry at a time (`.MainActivity` by default, `.IconCalculator` after switching,
back again), the app opens through the disguised entry and a `https://www.kithwall.com/...` link still lands
in it; with crash reports off a crash leaves no file, with them on `kw-crash.json` holds the class, the frames
and the app version, and no message. Found while doing so: the WebView's own handler ends the process itself,
so the recorder must run before it; the main thread now has its own handler (`KwCrash.guardMainThread`), which
Android calls before any default handler.
