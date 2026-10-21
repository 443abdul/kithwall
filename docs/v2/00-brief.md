# Kithwall 2 — Product brief

Status: draft for owner confirmation · 2026-10-20

## 1. What Kithwall is

A private social network for the people you actually know — family, friends, the circles you belong to —
built so that **nobody, including us, can read, sell or exploit what you share**. Everything you post, send
or store is end-to-end encrypted on your device. No ads, no tracking, no algorithmic feed, funded by
donations.

**One-line pitch:** *Your people. Your space. Sealed.*

The 2010 Facebook replica is retired from kithwall.com. It lives on, unchanged except for branding, as
**Classicbook** (`443abdul/classicbook`, private) — independently deployable.

## 2. Who it's for

| Audience | What they need from us |
|---|---|
| Families & friend groups | Effortless sign-up, a calm feed, albums, events, group chats, calls |
| Privacy-minded public | A real alternative to Meta/X/TikTok that is pleasant to use |
| At-risk people (activists, journalists, minorities) | Strong defaults, minimal metadata, duress/panic tools, deniability, works on restricted networks |
| Global, multilingual | 16 languages at launch incl. right-to-left, works on cheap Android phones and slow networks |

**Conflict rule:** when convenience and protection disagree, **protection is the default**; users can relax it
for themselves with a clear explanation of the trade-off.

## 3. Principles

1. **We can't see it.** Content, names, photos, circle names, reactions, call media: encrypted on device.
2. **Collect almost nothing.** No phone number. Email optional. No contact upload. No analytics. Short logs.
3. **Calm, not compulsive.** Chronological feed, no infinite engagement tricks, no public like counts by default, "you're all caught up".
4. **Safe by default.** Disappearing messages on, read receipts off, profile details visible only to connections (anyone else can find you only by typing your exact @handle).
5. **Prove it.** A live "What Kithwall knows about you" page, one-tap export, open source code (AGPL-3.0, linked from the app at the exact running version), verifiable safety numbers.
6. **Everyone, everywhere.** Accessible (WCAG 2.2 AA), RTL, low-bandwidth mode, installable, native apps.

## 4. Product structure

Bottom tabs (phone) / left rail (desktop):

1. **Home**: stories row on top, then a chronological feed from your connections and circles; composer.
2. **Circles**: groups of people (Family, College friends, Neighbourhood). Each circle has its own feed, chat, albums, events and notes. They replace 2010 Groups.
3. **Messages**: 1:1 and group chats, voice notes, voice/video calls.
4. **Activity**: notifications and connection requests.
5. **You**: profile, albums, notes, events, Safety centre, settings, donate.

### Kept from v1, redesigned
Posts (text, photos, video, link previews and click-to-play embeds), comments and reactions, albums and
tagging, encrypted video up to 100 MB, events with RSVP, groups (now Circles), notes (now long posts and
journals), messaging, push notifications, recovery key and trusted-friend recovery, moderation and reporting,
admin tools.

### Dropped
Pages, Questions, Places, Pokes, Kithville and games, the "Wall" metaphor, the 2010 desktop and the 2010 look.

### New
- **Stories** (24 h) for connections or a chosen circle.
- **Disappearing content:** per chat or post timers. Default for chats: 4 weeks. Optional for posts.
- **Scheduled posts** (queued on device, sent when due), **edit** and **unsend** everywhere.
- **Safety centre:**
  - Duress PIN: opens a harmless decoy profile and silently hides real content.
  - Panic wipe: locks the app and clears local keys; recoverable later with the recovery key.
  - Hidden chats and contacts behind a PIN.
  - Screenshot notice (native apps).
  - Safety check-ins: "if I don't check in by X, alert these people".
  - Session and device list with remote sign-out.
- **Transparency:**
  - "What Kithwall knows about you": live, from the server's actual rows.
  - One-tap encrypted export and full delete.
  - Safety numbers / QR verification.
  - Transparency report.
- **Calls:** E2EE voice and video, 1:1 and small groups (WebRTC with insertable-streams encryption;
  relay via Cloudflare TURN, which only ever sees encrypted packets).
- **Voice notes.**
- **Donate** page and a supporters wall (opt-in, pseudonymous).

## 5. Sign-up (target: under 30 seconds)

1. **Choose a style:** Warm, Minimal or Bold; light, dark or system. It can be changed any time.
2. **Your name** (display only) and a **@handle**.
3. **Create a passkey** (Face ID, fingerprint or device PIN). Your encryption keys are generated on device and
   wrapped with the passkey (WebAuthn PRF). There is no password and no email required.
   - Fallback for devices without passkey/PRF: a passphrase (Argon2id), as in v1.
4. **Find people:** share your invite link or QR code. There is no contact upload.
5. Afterwards, gentle nudges (not blockers) to:
   - save the recovery key, or add trusted friends;
   - optionally add an email for account notices;
   - add a second passkey or device.

Bot and spam protection stays invisible: proof-of-work (ALTCHA) plus rate limits. There is no CAPTCHA puzzle.

**Migration:** existing v1 accounts keep their keys, connections and content. At first sign-in with their
password, the app offers to add a passkey. Old posts appear in the new feed. 2010-only content (pokes,
Kithville, questions) is dropped after export is offered.

## 6. Design

- **Three styles**, each with light and dark, chosen at sign-up and switchable in settings:
  - **Warm:** soft neutrals, rounded shapes, friendly type (default suggestion).
  - **Minimal:** crisp monochrome with one accent.
  - **Bold:** vibrant colour and playful motion.
- A single token-based design system (CSS variables), so a style is just a token set. Components never
  hard-code colours.
- Mobile-first; on desktop, a three-column layout (rail, content, context panel).
- Typography that covers Latin, Arabic/Urdu (Nastaliq-friendly), Devanagari, Bengali, CJK and Cyrillic.
  System fonts plus self-hosted Noto subsets; nothing is loaded from Google at runtime.
- Accessibility: WCAG 2.2 AA, reduced-motion support, dynamic text size.

## 7. Languages at launch

English, Urdu, Arabic, Persian, Hindi, Bengali, Chinese (Simplified), Russian, Spanish, French, Portuguese,
Turkish. Right-to-left for ur, ar and fa. Initial translations are machine-drafted and marked for native-speaker
review. Language is auto-detected from the device and can be changed any time.

## 8. Platforms

- **Web / PWA** (kithwall.com): installable, with push notifications (already live).
- **iOS and Android via Capacitor:** the same app, plus native push, biometrics, secure key storage (Keychain
  / Keystore) and the screenshot notice. Android is also distributed as a direct APK / F-Droid build for
  at-risk users without Play Store access.

## 9. Funding

Donations only. Everything is free, with no supporter tier or paywall. Kithwall is open source under
AGPL-3.0-only (owner decision, phase 6).
- **At launch no donation method is set up.** /donate explains that and lists other ways to help (code,
  translations, security reports, invites, running your own instance). Methods (Monero, Bitcoin, BTCPay, a
  fiscal sponsor) appear only when their `NEXT_PUBLIC_DONATE_*` variable is set (`docs/deploy.md`).
- Donations go through an external processor (e.g. Open Collective, Liberapay, Stripe donation link). No card
  data touches Kithwall.
- App stores: Apple only allows in-app donation links for registered nonprofits, so on iOS the donate page
  opens the website. Google Play allows donation links.

## 10. Technical approach

Keep and extend the v1 foundation: Next.js 16, Supabase (Postgres with RLS, Storage, Realtime),
`packages/crypto`, Web Push. The UI is rebuilt from scratch on a new design system with i18n; v1 page
components are deleted rather than restyled. New pieces:
- passkey/PRF key wrapping
- a stories table
- expiring and scheduled content (server-side TTL deletion of ciphertext)
- a calls signalling channel over Realtime, with Cloudflare TURN credentials minted per call
- the Capacitor shell
- an i18n message catalogue

## 11. Phases

| # | Phase | Ships |
|---|---|---|
| 0 | Archive | Classicbook repo, `v1-classic` tag ✅ |
| 1 | Foundation | Design system (3 styles × light/dark, RTL), i18n framework, new app shell, passkey sign-up, v1 account migration |
| 2 | Core | Home feed, stories, composer, profiles, connections, Circles, events, albums, notes, messages, activity |
| 3 | Privacy and safety | Disappearing, scheduled, edit and unsend; Safety centre; transparency page; export; safety numbers |
| 4 | Calls | Voice notes, E2EE 1:1 and group calls (Cloudflare TURN) |
| 5 | Native | Capacitor iOS/Android, native push, biometrics, store listings, APK/F-Droid |
| 6 | Launch | 12-language translations, landing page, donate, legal update, security review, deploy |

Each phase is deployed to kithwall.com when it is green: tests, typecheck, and a browser check at phone and
desktop sizes.

## 12. Needs from the owner

- Apple Developer ($99/yr) and Google Play ($25) accounts, for phase 5.
- A Cloudflare account with a Realtime/TURN app (API token), for phase 4.
- A donation processor account and link, for phase 6.
- Native-speaker reviewers for translations (optional but recommended).
