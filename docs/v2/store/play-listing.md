# Google Play listing draft (English)

Status: draft for the owner · 2026-10-21 · app `com.kithwall.app`, `play` flavour (`docs/v2/05-native.md`).
Everything here must stay true to `docs/v2/03-transparency.md` (the data map) and the privacy policy.

## Basics

| Field | Value |
|---|---|
| App name (30) | Kithwall |
| Short description (80) | Private social network for real friends. End-to-end encrypted. No ads, no tracking. |
| Category | Social |
| Tags | social network, messaging, privacy |
| Contact email | security@kithwall.com (or a support address) |
| Website | https://www.kithwall.com |
| Privacy policy URL | https://www.kithwall.com/legal/privacy |
| Price | Free. No in-app purchases. No ads. (Donations happen on the website; Play allows donation links.) |
| Target API level | 36 (Android 16), the Play requirement for new apps and updates from 31 Aug 2026; minimum Android 9 (API 28) |
| Content rating | IARC questionnaire: social features with user-to-user communication and user-generated content; no violence/sexual content by the app itself. Expect "Teen"/PEGI 12 because of unmoderated private communication. |
| Target audience | 16+ (or 18+ if the legal review prefers); not designed for children |

## Full description (≤ 4000)

Kithwall is a social network for the people you actually know: friends, family, your circles. It feels
like the social web used to — a home feed in order, profiles, photo albums, events, notes, messages and
calls — without the parts that made it worse.

**Private by design**
• Posts, photos, stories, messages, voice notes and calls are end-to-end encrypted on your phone. Kithwall's
  servers store only data they cannot read.
• No ads, no tracking, no algorithmic feed, no data sales. Kithwall is funded by donations only.
• Sign in with a passkey: no email and no password needed. Your keys are protected by your passkey and
  never leave your devices unencrypted.
• "What Kithwall knows about you" shows, live, every piece of data the server holds about your account.

**Made for people at risk**
• Safety centre: app PIN, a duress PIN that opens an empty decoy account, wipe this device, quick exit.
• Hide chats behind your PIN. Notifications for hidden chats say only "You have new activity."
• Safety check-ins: if you don't check in by a time you choose, chosen friends get your encrypted message.
• Optional: block screenshots and hide the app preview; unlock with fingerprint or face.
• Notifications are encrypted for your phone: Google's push service only carries ciphertext.
• Safety numbers to verify the people you talk to.

**Everything you'd expect**
Home feed and stories, profiles, connections and Circles, events with RSVPs, photo albums, notes,
one-to-one and group chats, disappearing and scheduled messages, edit and unsend, end-to-end encrypted
voice and video calls. 12 languages, including right-to-left Urdu, Arabic and Persian.

Kithwall is also available as a website (kithwall.com) and as an APK without any Google services for people
who can't or don't want to use Google Play.

## Graphics (to produce)

- Icon 512×512: `apps/mobile/scripts/gen-assets.mjs` renders the mark (two rings on the warm accent
  `#b4532a`); export a 512 px PNG from the same SVG.
- Feature graphic 1024×500: the mark + "Kithwall — your people, sealed."
- Phone screenshots (≥ 2, 1080×1920): home feed, chat with the lock icon, Safety centre, "What Kithwall
  knows about you", a call. Use test accounts only.

## Permissions — justification (Play Console and review notes)

| Permission | Why | When asked |
|---|---|---|
| `INTERNET` | The app is the Kithwall service | — |
| `POST_NOTIFICATIONS` | New messages, calls and activity (opt-in) | When the person turns notifications on |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Voice/video calls and voice notes | At the first call / voice note |
| `CAMERA` | Video calls; scanning a safety-number QR code | At the first video call / scan |
| `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | Only when the person taps "Attach my location now" on a safety check-in (one reading, end-to-end encrypted) | At that tap; never in the background |
| `USE_FULL_SCREEN_INTENT` | Incoming calls ring over the lock screen (Kithwall is a calling app: 1:1 and group voice/video calls) | Declared in *App content → Full-screen intent* |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CAMERA` | A connected call keeps its microphone (and camera, for video) while the person switches to another app; a "Kithwall call in progress" notification shows meanwhile. Only during a call the person started or answered | Declared in *App content → Foreground service permissions* ("ongoing call", with a video) |
| `USE_BIOMETRIC` | Optional unlock with fingerprint/face instead of the app PIN | When the person turns it on |
| `DETECT_SCREEN_CAPTURE` | Android 14+: show a local notice after a screenshot (nobody else is told) | — (normal permission) |
| `VIBRATE` | Notification / ringing vibration | — |
| FCM-added: `WAKE_LOCK`, `RECEIVE` (c2dm) | Delivery of encrypted push messages | — |

No background location, no contacts, no SMS/call log, no storage-wide access, no accessibility service.

## Data safety form — answers

Principles used: Google's definition counts data as **collected** when it leaves the device in a form the
developer could read. Data that is **end-to-end encrypted** so only the sender and recipients hold the keys
is **not** collected (Play's exemption). Data processed only on the device is not collected.

**Does your app collect or share any of the required user data types?** Yes (collected; **not shared** with
third parties). **Is all user data encrypted in transit?** Yes (HTTPS/TLS only; cleartext disabled).
**Do you provide a way for users to request that their data be deleted?** Yes: in the app (Settings → Your
data → Delete account, immediate) and on the web; deletion removes every row and file (crypto-shredding of
the encrypted content).

| Data type (Play) | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| Personal info → **Name** | No | — | — | Display names are end-to-end encrypted (exempt). Only people who choose to join the public directory publish a name — say "Yes, optional, App functionality" if you prefer to disclose that. |
| Personal info → **Email address** | Yes | Optional | Account management | Optional notice address (verified) for security notices; older v1 accounts use email sign-in. Passkey accounts have none. |
| Personal info → **User IDs** | Yes | Required | App functionality, Account management, Security/fraud prevention | Account id, public @handle, public keys, passkey credential ids. |
| Personal info → Address, phone, race, religion, sexual orientation, other | No | | | |
| Financial info | No | | | Donations are handled by an external processor on the website. |
| Health and fitness | No | | | |
| **Messages** → Emails / SMS / Other in-app messages | No | | | Messages, posts, comments are end-to-end encrypted (exempt). The server stores who is in a conversation and when messages were sent; disclose under "App activity → Other actions" (below). |
| **Photos and videos** | No | | | End-to-end encrypted before upload (exempt). |
| **Audio files** (voice notes) / call audio | No | | | End-to-end encrypted (exempt). |
| Files and docs | No | | | |
| Calendar (events) | No | | | Events are end-to-end encrypted, except events the creator makes public. |
| Contacts | No | | | The app never reads the phone's contacts. Connections between accounts are under "App activity". |
| **App activity → Other user-generated content / Other actions** | Yes | Required | App functionality, Security/fraud prevention | Server-visible metadata: connections/friendships, circle and chat membership, timestamps of posts/messages, reactions' existence, notifications, reports filed. |
| App activity → In-app search history, installed apps, web browsing | No | | | |
| Web browsing | No | | | |
| App info and performance → **Crash logs / Diagnostics** | No | | | No crash reporting or analytics SDKs. ML Kit (on-device translation) would log usage metrics; its uploader is removed from the play manifest (`05-native.md` §12), so they are never sent. Re-check with a network capture before answering. |
| **Device or other IDs** | Yes | Optional | App functionality | Push token (FCM registration token) and the device's push public key, only when notifications are turned on; coarse device label ("Kithwall app on Android"). |
| **Location** (approximate/precise) | No | | | The optional check-in location is end-to-end encrypted (exempt) and only sent when the person taps to attach it. |

On-device translation (play build): the text being translated never leaves the phone (processed on the device,
not collected). Downloading a language pack fetches a model file from Google (ML Kit may use a per-installation
identifier for that, per Google's ML Kit data disclosure); no content is sent.

Security practices to tick: data encrypted in transit; users can request deletion; (optionally) "committed
to follow the Play Families policy" — no (not a kids app); independent security review — only once done.

Also state in the privacy policy (already in the transparency page's "Outside the database"): hosting logs
(IP address, user agent) kept briefly by the hosting provider for operations and abuse prevention — this is
"ephemeral/operational" and covered by the privacy policy; sign-in session records (IP, user agent) in the
auth system are visible to the person in "What Kithwall knows about you".

## Review notes for Google (App access)

"Sign-up needs no email: tap *Create account*, pick a handle, solve the proof-of-work, create a passkey (or
choose a passphrase). For review, use the test account below (passphrase sign-in)." → create a dedicated
review account on production and paste its handle/passphrase in Play Console *App access* (never in this
repository).

## Release notes template

"Kithwall for Android: end-to-end encrypted social network. Native passkeys, encrypted notifications, app
PIN with duress PIN, biometric unlock, screenshot protection."
