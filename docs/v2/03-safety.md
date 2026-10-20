# Kithwall 2: Safety centre

Status: implemented (phase 3) · 2026-10-24 · see also `00-brief.md` §2 (at-risk people) and §4, and
`01-accounts.md` (key hierarchy)

The Safety centre lives at `/you/safety` (linked from You and Settings). It is for people whose phone,
account or person may be at risk: someone looking through an unlocked phone, someone forcing them to
unlock it, a lost device, or not coming home. Every screen states its limits plainly.

| Page | What it does |
|---|---|
| `/you/safety` | Panic card (**Lock now**, **Wipe this device**), links to the rest, honest limits |
| `/you/safety/lock` | App PIN, auto-lock, wipe after N wrong PINs, duress PIN and decoy, quick exit |
| `/you/safety/hidden` | Hide chats behind the app PIN; reveal / conceal |
| `/you/safety/checkins` | Safety check-ins ("if I don't check in by X, alert these people") |
| `/you/safety/devices` | Signed-in sessions (coarse last-seen), push devices, passkeys; sign out one / all others |
| `/you/safety/tips` | Synced passkeys, server metadata, Tor, screenshots, shared devices, notifications, recovery |

Code: `lib/safety/*` (logic), `components/safety/*` (screens), `components/shell/AppGate.tsx` (lock
screen and decoy gating), `lib/keys/session.ts` (`onLock`, `unlockWithDeviceAmk`), `lib/keys/device.ts`
(`pinStore`), `public/sw.js` (hidden-chat push previews), `styles/v2/safety.css`, migration
`20261024000500_safety_checkins.sql`.

## 1. Key hierarchy additions

```
 app PIN ──Argon2id(salt)──► pinKey ──wraps──► AMK          (device-local only, never uploaded)
 duress PIN ─Argon2id(salt)─► duressKey ─seals─► "duress" marker
                 └───────── both inside one record, encrypted again with a NON-EXTRACTABLE
                            WebCrypto AES-GCM key in IndexedDB ("kithwall-device"/"pin")
```

| Value | Definition |
|---|---|
| `salt` | 16 random bytes per device, kept across PIN changes |
| `pinKey` | `deriveFromPassword("kithwall/v1/app-pin/<salt>", PIN)` → `passwordKEK` (Argon2id m=64 MiB, t=3, then HKDF) |
| `amk` | `encryptBlob(pinKey, AMK, "kithwall/v1/app-pin/amk/<userId>")` (XChaCha20-Poly1305) |
| `duress` | `encryptBlob(duressKey, "duress", "kithwall/v1/app-pin/duress/<userId>")`, or the same under a **random** key when no duress PIN is set, so the record looks the same either way |
| outer | AES-GCM-256 under a fresh non-extractable key, AAD `kithwall/v1/device-pin/<userId>`; also holds the duress action, decoy name, public @handle and wipe-after-N |

Checking a PIN costs one Argon2id run whatever the outcome: the derived key is tried against `amk` and then
`duress` (two cheap decryptions), so real, duress and wrong PINs take the same time. Code:
`lib/safety/pin.ts` (pure, unit-tested), `lib/safety/applock.ts`.

While an app PIN is set, "keep me signed in" is off: `deviceStore.save()` refuses to store the plain AMK,
and enabling the PIN deletes any stored one. Every open of the app (and every lock) shows the PIN pad.
The passkey / passphrase unlock stays available behind "Use a passkey or passphrase instead".

## 2. App lock

- **Lock** (`lockNow()`, or any `lock()` caller, via the `onLock` hook): stops the keyring, zeroes the
  AMK in memory, then **reloads the page**, so query caches, decrypted names and message caches are gone.
- **Auto-lock** (device preference in localStorage `kw.safety.lock`): after 1/5/15/60 minutes without
  input, and optionally as soon as the tab is hidden. Enabling the PIN turns on a 5-minute idle lock.
- **Wrong PINs** (`lib/safety/limiter.ts`): three free tries, then 30 s, 1 min, 5 min, 15 min, 1 h.
  Optional **wipe after 5/10/15** consecutive wrong PINs. The counter lives on the device
  (`pin-attempts`), so it slows guessing on this device; it is not a cryptographic limit.

## 3. Duress PIN and decoy

A second PIN (must differ from the app PIN; checked both ways). Entering it on the lock screen:

1. resets the wrong-PIN counter exactly like a real PIN (no visible difference), then
2. switches `AppGate` to `components/safety/DecoyApp`: the same frame, tabs and empty states as a
   brand-new account (empty feed with a working composer whose posts stay on screen only, "No chats yet",
   "You're all caught up", a profile with the chosen decoy name and the public @handle, 0 connections,
   Settings with appearance and language, Lock, Sign out). No keys are loaded, nothing is fetched, and
   the real screens never mount. The lock screen itself is anonymous (no name or avatar) so it looks the
   same in front of either.
3. runs the configured action silently: **nothing else** (the real account stays on the device, locked;
   lock the decoy and enter the real PIN later), or **wipe this device** in the background (§4) while
   the decoy stays on screen.

Whether a duress PIN is set cannot be read from the device record. The settings screen remembers it in
the encrypted vault (`safety.duress[<salt>]`), which only a real unlock can read. Entering the duress PIN
at the "reveal hidden chats" prompt counts as a wrong PIN.

## 4. Panic wipe and quick exit

`wipeThisDevice()` (`lib/safety/wipe.ts`), each step time-boxed so it finishes offline:
unsubscribe push and delete this device's subscription row → local sign-out (Supabase revokes this
session's refresh token) → zero the AMK → delete `kithwall-device` (remembered AMK, PIN record,
counter), `kithwall-sw` and every other IndexedDB database of the origin → Cache Storage → unregister the
service worker → clear localStorage and sessionStorage. The account and its content on the server are
untouched; come back with a passkey, the passphrase or the recovery key.

**Quick exit** (opt-in, `kw.safety.exit`): a shield button in the corner, a triple tap on the logo, or
Esc three times. It hides the page at once (`html.kw-exiting`), wipes (or only locks), and
`location.replace()`s to Wikipedia, a weather page or a search engine (fixed list). The browser history
still shows Kithwall; the UI says so.

## 5. Safety check-ins

"If I don't check in by <time>, alert these people." One-off, or **repeat daily** (checking in moves the
deadline to the same time the next day). Deadline 5 minutes to 31 days ahead; up to 10 people; at most
5 armed check-ins.

1. The device composes the alert in the sender's language: a header ("I didn't check in by …"), the
   person's own message, the optional **last known location** (only when they tap "Attach my location
   now"; one `getCurrentPosition`, rounded to 5 decimals, as an OpenStreetMap link) and a footer.
2. For each contact it opens (or creates) the one-to-one chat and **seals the alert now** as an ordinary
   message: `sealEnvelope` with the conversation key, the sender's signature and a message id fixed in
   advance (the id is in the signed header).
3. `create_safety_checkin(due, repeat, alerts[])` stores the check-in and the sealed messages in
   `safety_checkin_alerts`. RLS shows both tables to their **owner only**; there is no policy through
   which a recipient could see them, and nothing appears in the chat.
4. **I'm OK** (`safety_check_in`) deletes a one-off check-in with its alerts, or re-arms a daily one.
   **Cancel** deletes. **Alert now** (`safety_checkin_alert_now`) releases at once.
5. A `pg_cron` job every minute (`kw.release_due_checkins()`, not callable by users) copies due alerts
   into `public.messages` with the sender, conversation, epoch and envelope unchanged, skipping chats
   that are gone or blocked, then marks the check-in released. The existing `AFTER INSERT` trigger sends
   the normal "new message" push; recipients decrypt it like any other message. Released check-ins are
   removed after 7 days.

The server learns that a check-in exists, its deadline, whether it repeats, and which one-to-one chats
(so which people) would be alerted. It never sees the text or the location.

## 6. Hidden chats

`lib/safety/hidden.ts` keeps the hidden conversation ids **only** in the encrypted vault (namespace
`safety`, `lib/settings.ts` pattern). Hiding needs an app PIN on this device; revealing asks for it and
lasts until the app locks. API for other screens:

```ts
useHiddenChats(): Set<string>     // ids to leave out of lists, badges and previews now (empty while revealed)
useHiddenChatIds(): Set<string>   // every hidden id, revealed or not
isRevealed(): boolean; useRevealed(): boolean; isHiddenChat(id): boolean
hideChat(id): Promise<void>; unhideChat(id): Promise<void>; canHideChats(): boolean
concealHiddenChats(): void        // revealing: <RevealHiddenDialog/> in components/safety/PinDialog
```

Push previews: the server can't know which chats are hidden. The app writes salted SHA-256 hashes of the
hidden ids to IndexedDB (`kithwall-sw`, `lib/safety/swmirror.ts`); `public/sw.js` hashes the
conversation id of each message push and, on a match, shows a generic "You have new activity on
Kithwall." with no sender and a link to Activity.

## 7. Devices and sessions

Uses the existing `my_sessions()` / `revoke_my_session()` RPCs and `auth.signOut({ scope: 'others' })`.
Last-seen is shown coarsely (now / today / this week / this month / earlier). Also lists the devices with
push subscriptions (with "stop") and the passkeys (managed in Settings → Security).

## 8. Threat model notes

- **Protects against:** someone browsing an unlocked or borrowed phone; casual coercion to "unlock and
  show me"; a lost device (remote sign-out, PIN, wipe-after-N); notification previews on the lock screen
  for hidden chats; not being found in time (check-ins).
- **Does not protect against:** forensic analysis of a seized device (the decoy is a UI, not a hidden
  volume; IndexedDB records, service-worker data and browser history exist and can be found); malware or
  a malicious browser extension; a malicious server serving modified JavaScript (the web-E2EE limit from
  `01-accounts.md` §5); anyone who learns the passkey, passphrase or recovery key (the account still
  exists on the server, and a duress PIN only affects this device).
- **App PIN strength:** the PIN is useless off the device (it opens a wrap that is itself encrypted under
  a non-extractable key). On the device, an attacker who can run script in the browser profile can use
  that key, reset the attempt counter and guess offline at roughly one Argon2id (≈0.5–2 s) per guess: a
  6-digit PIN falls in days to weeks, not years. Hence the minimum of 6 digits, the trivial-pattern
  check, and the advice to also use the OS screen lock.
- **Duress:** the duress record is indistinguishable from a no-duress record without the PIN, but the
  decoy's existence is only plausible deniability against a non-expert. A coercer who forces the
  "passkey or passphrase" path bypasses it.
- **Revocation:** signing a session out deletes its refresh token; its current access token can work for
  up to an hour (the UI says so). A locked device needs its keys again anyway.
- **Check-ins metadata:** deadline and recipients are visible to the server (and to a database
  attacker), and an attacker with database write access could release or delete pending alerts; they
  can't read or forge them (signed and encrypted on the device).
- **Hidden-chat hashes** in `kithwall-sw` only stop casual reading: anyone with a conversation id can test
  it. The app icon badge (computed by the server) may still count hidden chats.

## 9. Tests

- `apps/web/src/lib/safety/pin.test.ts` (16): PIN rules, wrap/unwrap, user binding, salts, weak-KDF
  refusal, tampering, duress detection and separation, duress survives a PIN change, limiter schedule and
  wipe-after-N.
- `supabase/tests/safety_checkins.test.sql`: arming rules (deadline window, 1:1 chats only, no planting
  in others' chats, RPC-only writes), hidden from recipients and strangers until the deadline, check-in
  deletes / re-arms, cancel deletes alerts, only the clock (or the owner's "alert now") releases, release
  copies the sealed envelope into a normal message once, skips blocked chats, limits.
- Browser checks (Playwright, system Chrome; scripts kept out of the repo): PIN on/lock/reload/wrong/right,
  duress → decoy → real PIN, duress with wipe (stores cleared behind the decoy), hide/reveal/conceal on
  lock, check-in with location released by pg_cron and read by the recipient, cancel, wipe, quick exit
  (Esc ×3). Screens: `docs/v2/screens/phase3-safety-*.png` (1280, 375, Arabic dark).

## 10. Open items

- Filtering the chat list and the nav unread badge through `useHiddenChats()` belongs to the messages
  screens (`components/messages/ChatList.tsx`, `components/shell/AppShell.tsx` `useBadges`).
- Screenshot notice and Keychain/Keystore-backed device keys come with the native apps (phase 5).
- Hidden contacts (brief §4) are not built; only hidden chats.
- Daily check-ins repeat at the same UTC offset (a DST change shifts them by an hour).
