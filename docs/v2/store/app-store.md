# App Store listing draft (iOS, for later)

Status: draft · 2026-10-21 · needs the Apple Developer Program (owner checklist in `docs/v2/05-native.md` §9).
Bundle id `com.kithwall.app` (+ `com.kithwall.app.NotificationService`), iOS 16+ (passkey PRF needs iOS 18).

## Basics

| Field | Value |
|---|---|
| Name (30) | Kithwall |
| Subtitle (30) | Private social, sealed |
| Category | Social Networking (secondary: Lifestyle) |
| Age rating | 12+ or 17+ depending on the questionnaire answers for unrestricted user-generated content and messaging (Apple expects reporting and blocking, which exist) |
| Price | Free, no in-app purchases. Donations: the in-app donate page opens the website (Apple only allows in-app donation flows for registered nonprofits; see `00-brief.md` §9) |
| Privacy policy | https://www.kithwall.com/legal/privacy |
| Support URL | https://www.kithwall.com/help |
| Keywords (100) | private,encrypted,social,friends,family,messages,calls,safety,no ads,passkey |

Promotional text and description: reuse `play-listing.md` ("Full description"), replacing "APK without
Google services" with nothing (iOS has one build) and mentioning Face ID instead of fingerprint.

## App Privacy ("nutrition label")

Apple: data that is end-to-end encrypted so the developer can't read it doesn't have to be declared.

| Data type | Collected | Linked to the user | Tracking | Purpose |
|---|---|---|---|---|
| Contact info → Email address | Yes (optional notice address / older accounts) | Yes | No | App functionality, account management |
| Identifiers → User ID | Yes (account id, @handle, public keys) | Yes | No | App functionality |
| Identifiers → Device ID | Yes (APNs token + push public key, only with notifications on) | Yes | No | App functionality |
| User content → Other user content | Yes (server-visible metadata: connections, memberships, timestamps, reports) | Yes | No | App functionality |
| User content → Messages, Photos or videos, Audio | No (end-to-end encrypted) | | | |
| Location | No (optional check-in location is end-to-end encrypted) | | | |
| Usage data, Diagnostics, Purchases, Contacts, Health, Financial, Browsing | No | | | |

"Data used to track you": none. No third-party SDKs besides Capacitor.

## Export compliance

The app uses encryption beyond Apple's exempt uses (end-to-end encryption of user content with standard
algorithms: XChaCha20-Poly1305, X25519, Ed25519, AES-GCM, Argon2id). It is mass-market software using
standard cryptography (EAR category 5D992.c). In App Store Connect answer "Yes, uses encryption" →
"standard algorithms" → follow the prompts; get advice for the owner's jurisdiction (and the US BIS
self-classification requirements, if any apply) before submission. Do not set
`ITSAppUsesNonExemptEncryption = NO` in Info.plist.

## Usage descriptions (already in `ios/App/App/Info.plist`)

- Camera: video calls and scanning a safety-number code.
- Microphone: calls and voice notes.
- Face ID: optional unlock instead of the app PIN.
- Location (when in use): only when attaching a location to a safety check-in.

## Review risks and notes for App Review

- **Guideline 4.2 (minimum functionality / web wrappers).** The app loads the Kithwall web app. Point out
  the native features: passkeys with PRF-based key protection, Keychain-backed device keys, Face ID unlock,
  encrypted push decrypted in a Notification Service Extension, screenshot notices and app-switcher
  protection, verified universal links. Consider bundling the web app in a later version (§8 of
  `05-native.md`).
- **User-generated content (1.2).** Report, block, and moderation exist; mention them and the community
  standards URL.
- **Sign-in for review.** Provide a passphrase test account in App Review notes (not in the repository).
- **Push.** Alerts are generic ("You have new activity on Kithwall.") until the extension decrypts them on
  the device.
