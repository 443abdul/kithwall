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
| `pinKey` | `deriveFromPassword("kithwall/v1/app-pin/<salt>", PIN)` → `passwordKEK` (Argon2id m=128 MiB, t=3 for PINs set up since the security review (`PIN_KDF`; older records keep the m=64 MiB they were made with until the PIN is set up again), then HKDF) |
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
counter), `kithwall-sw`, `kw-kitdrop` (Kit Drop outbox and received files), `kw-offline` (what opens the
account offline, docs/v2/08-censorship.md §5.1), `kw-search` (the on-device search index, §14) and every other
IndexedDB database of the origin → Cache
Storage (including the offline shell) → unregister the service worker → clear localStorage and
sessionStorage. The account and its content on the server are
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
- **Data at rest on a seized or copied device (security review C1).** "Non-extractable" WebCrypto keys only
  stop *script* from exporting them. Chromium and Firefox keep their raw bytes in the profile's IndexedDB
  files, so anyone with the device itself or an image of its disk can use them. Concretely:
  - With **"keep me unlocked"** on (web), the AMK can be recovered directly: the account is open to whoever
    has the disk. The settings screen says so (`keys.rememberedBody`).
  - With an **app PIN**, the outer layer can be removed, the attempt limiter and wipe-after-N do not apply,
    and the PIN can be guessed offline. The cost per guess is one Argon2id run (128 MiB, t=3 for new PINs,
    roughly twice the account default). That slows a guesser down; it does not make a short PIN safe. Six
    digits are 10^6 candidates, which a many-core machine works through in hours to days; every extra
    digit multiplies that by ten. The UI recommends 8 or more digits (`PIN_RECOMMENDED`).
  - The **duress PIN** is only deniable against someone who doesn't image the device: offline, the
    attacker can tell which PIN opens the real AMK.
  - The **native apps** keep these records in Keystore / Keychain-backed storage (hardware-bound where
    the device supports it), which is the recommendation for people whose device may be taken. The
    Safety centre's "Honest limits" note (`keys.limits`) and the PIN description (`keys.pinBody`) say this
    in plain words.
  - Not done (yet): a server-assisted PIN limiter (a server-held pepper released only after a
    rate-limited proof) and binding the PIN wrap to a passkey's PRF output. Both would add a second factor
    that a disk image alone doesn't have; both change the unlock flow and need native support, so they are
    left for a later release.
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
- Done in phase 5 (`05-native.md` §4, §6): in the apps the device records live in Keystore/Keychain,
  optional biometric unlock (real unlock only; the duress PIN stays on the PIN pad), wipe also clears the
  native stores and push key, "Block screenshots and hide app preview" (off by default) and a local
  screenshot notice.
- Hidden contacts (brief §4) are not built; only hidden chats.
- Daily check-ins repeat at the same UTC offset (a DST change shifts them by an hour).

## 11. Verified reports of chat messages (message franking)

Added 2026-11-02; design and threat model in `03-franking.md`. Reporting a chat message can include the
message with cryptographic proof of who sent it: every message and edit carries a fresh franking key inside
its ciphertext and a commitment next to it, which the database tags with the sender, chat and time. The
report dialog has an "Include the message" switch (on by default) that says what is shared and whether the
message carries proof; with it off, moderators see only the reason, the note and who sent the message. The
database verifies included evidence when the report is filed and records the verdict (`reports.frank`), so a
report stays verifiable after the message was edited, unsent or has disappeared, and a reporter can't
fabricate one. Safety check-in alerts (§5) are franked when sealed and tagged when released. A message whose
commitment doesn't match renders as "This message couldn't be verified."

## 12. Legacy contact

Status: implemented 2026-11-02 (roadmap 2026-11, item C2) · migration `20261102000200_legacy_contact.sql`

A person picks **one** of their connections as their legacy contact, an inactivity period (3, 6 or 12 months)
and, if they like, a farewell note. If they don't open Kithwall for that long, the contact receives the note and
may choose to remember the account. Settings → Security, sections "Legacy contact" (`#legacy`) and "People who
chose you" (`#legacy-for`).

Code: `lib/legacy/model.ts` (dates, note payload; pure), `lib/legacy/note.ts` (sealing; pure),
`lib/legacy/legacy.ts` (RPCs, heartbeat, reseal, export), `components/settings/LegacySettings.tsx`,
`components/shell/LegacyHeartbeat.tsx`, `app/api/cron/legacy/route.ts`, and the remembered state in
`components/people/ProfileScreen.tsx`, `PersonActions.tsx` and `components/posts/Birthdays.tsx`.

### 11.1 The note

Sealed on the owner's device with the signed sealed box (`packages/crypto` `seal`; v2 = hybrid X25519 +
ML-KEM-768 when the contact has a verified post-quantum key), signed by the owner's identity key, twice:

| Copy | Sealed to | Context | Purpose |
|---|---|---|---|
| `sealed_note` | the contact's identity key as trusted on the owner's device (`sealGate` refuses an unconfirmed key change) | `legacy-note/<owner>/<contact>` | what the contact opens after release |
| `sealed_self` | the owner's own key | `legacy-note-self/<owner>` | lets the owner read and change the note later, and reseal it |

The plaintext is `{v, text, at}` padded with spaces to a multiple of 512 bytes (at least 1 KiB), up to 5,000
characters. The context binds writer and recipient, so the server can't hand one person's note to someone else
or pass it off as written by another person. `note_kx` records the contact key it was sealed to.

Once a day, when the owner opens the app, their device checks whether the note must be sealed again (the
contact's trusted key changed, the owner's own identity changed, or the contact gained a post-quantum key while
the box is still classical) and reseals it from `sealed_self` (`noteNeedsReseal`). The contact's device tries
its current and earlier key-exchange keys (`previousKx`), so a note sealed before the contact rotated their
identity still opens.

### 11.2 Activity, reminders and release

- **Activity.** Nothing suitable existed (Auth session refresh times disappear on sign-out and also tick with
  background token refreshes), so the signed-in, unlocked app calls `legacy_seen()` at most once per UTC day per
  device (and again when it returns to the foreground on a new day). It sets `last_active_on` to today. **Only
  people with a legacy contact have this date stored, in their own row, at day granularity.** The duress decoy
  never calls it.
- **Daily job.** Vercel Cron `GET /api/cron/legacy` (`CRON_SECRET`, `45 4 * * *`) calls `legacy_tick()`
  (service role only). This is the project's third daily cron; the Hobby plan ran three at launch
  (`07-launch.md`). It sends a reminder about 30 days and again about 7 days before the end of the period: an
  in-app notification to the owner, whose insert trigger sends the push "Open Kithwall to keep your legacy contact
  on hold", and, if the owner set up a verified notice email, a content-free email (no names, no note;
  deduplicated through `notice_emails`).
- **Release** happens no earlier than the end of the period **and** at least 7 days after the second reminder,
  so a late or missed run only ever delays a release. `released_at` is set and the contact gets a notification
  (with push): "<name> left a note for you". The two must still be connected, with no block.
- **Coming back.** The first `legacy_seen()` after a release clears `released_at` and the remembered state and
  quietly tells the contact (in Activity, no push). A contact who already read the note keeps what they read.

### 11.3 Who sees what

| Who | Before release | After release |
|---|---|---|
| Owner | their whole row (`select` policy); changes through `set_legacy_contact` / `remove_legacy_contact` | the same |
| Contact | `legacy_for_me()`: who chose them and since when; `decline_legacy_contact` steps back (the owner is told kindly) | also when it was released and whether there is a note; `legacy_note(owner)` returns the sealed note; `remember_account(owner, on)` |
| Anyone else | nothing (no policy, no function) | nothing; a remembered profile shows "Remembering <name>" to whoever may see the profile |

All writes go through `SECURITY DEFINER` functions; `authenticated` has no insert, update or delete on the
table. The notifications (`legacy_contact`, `legacy_declined`, `legacy_cleared`, `legacy_reminder`,
`legacy_released`, `legacy_active`) are written only by that code (`kw.notification_ok` refuses them from
clients). Ending the connection (or blocking, which ends it) clears the legacy contact; the owner is told only
when the other person removed the connection, never after a block. Account deletion cascades.

**Remembering** (`profiles.memorialised_at`, changeable only inside the legacy functions,
`kw.profiles_memorial_guard`): the profile shows a gentle "Remembering <name>", birthday reminders leave the
person out (on the device), new connection requests and invite links (`friendships_memorial_guard`) and new chats
or chat additions (`audience_members_memorial_guard`) are refused by the database, and the Connect and Message
buttons are hidden. Existing content keeps its audiences and existing chats stay.

### 11.4 Threat model

- **The server can't read the note**, early or ever: it holds two sealed boxes, one openable only with the
  contact's private key and one only with the owner's. Database access, backups or a legal demand yield
  ciphertext.
- **The server controls timing.** A malicious operator (or anyone with database write access) could release a
  note early, never release it, suppress reminders or rewind `last_active_on`. An early release lets the contact
  read the note while the owner is still around: that is the honest limit of a server-run "dead man's switch",
  and the setup screen says that Kithwall decides when the note is passed on but can never read it. The owner's
  app undoes a release the next time it is opened, and the contact is told.
- **Metadata it learns:** that a person has a legacy contact and who, the period, the last day they opened the
  app (only for these people), when reminders went out and when a note was released, and roughly how long the
  note is (padded).
- **A wrong contact key served by the server** at sealing time is refused unless it is the pinned key or a
  vouched or verified change (`sealGate`), as for every other key delivery.
- **A forged or swapped note** fails the signature and context check on the contact's device ("This note
  couldn't be verified").
- **Not protected:** the web-E2EE limit (modified JavaScript could read the note as it is typed); a contact who
  shares the note after release; someone using the owner's unlocked app (that counts as activity).

### 11.5 Tests

`supabase/tests/legacy_contact.test.sql` (65): only connections can be chosen, period values, no direct writes,
no self-made remembered state, nothing visible to the contact before release except "you were chosen" and
nothing to anyone else ever, reminders at 30 and 7 days, a week's notice after a late reminder, a single release,
the note only after release, remembering refuses new connections and chats but keeps existing ones, coming back
clears everything and tells the contact, decline / remove / unfriend / block (the block isn't revealed), account
deletion cascade, execute rights. `apps/web/src/lib/legacy/legacy.test.ts`: month arithmetic matching Postgres,
note padding and length limit, sealing (opens for the contact and the owner only, bound to writer and recipient,
opens after a contact key rotation), reseal detection. `components/activity/activityModel.test.ts`: the legacy
notices and where they lead.

## 13. Disguised app icon (Android app)

Status: implemented 2026-11-11 · Android side and device test steps: `05-native.md` §14

For people who need to hide that they use Kithwall. Safety centre → App lock → **App icon** (shown only in the
Android app, 2.5.0 or newer): the app can show on the home screen as **Kithwall** (default), **Calculator**,
**Notes** or **Weather**. Name and icon both change; opening it is Kithwall as usual, behind the app PIN if one
is set. Code: `components/safety/AppIcon.tsx`, `lib/native/shell.ts` (`getAppIcon` / `setAppIcon`),
`KwIcons.java`.

What the screen says, because a disguise is a different icon and not a hidden app:

- The phone's own list of apps (Settings → Apps), the app store and the "app info" screen still say Kithwall.
- Notifications and the incoming-call screen still carry the Kithwall name and logo. The settings that cover
  those are linked right there: notifications off on this phone, hidden chats (their notifications don't say
  who wrote), and "Block screenshots and hide app preview".
- Switching takes a few seconds, Kithwall usually closes once when the icon changes, and some home screens
  move the icon or drop it from the home screen (it is then in the list of all apps).

Not changed: the panic wipe and the duress PIN work exactly as before, and neither brings the real icon back
(Android keeps the choice; a wipe must not undo a disguise). The choice is per phone and is not known to the
server. Threat model: this protects against someone glancing at the home screen or the app drawer. It does
not protect against someone who opens the system's app list, sees a notification arrive, inspects the phone
with a computer, or simply opens the "Calculator" and finds a lock screen.

## 14. Search on your phone

Status: implemented 2026-11-11 · code `lib/search/*`, `components/search/*`

Searching your own chats and posts without the server ever seeing a query or an index: it can't search what
it can't read, so the device does it, over what it has already decrypted.

- **Index.** `lib/search/store.ts`: one record per message, post or comment this device decrypted (text,
  author, time, the chat or post it belongs to, when it disappears). Fed by the decrypting code itself
  (`readMessage`, `readPost`, `readComment` call `noteMessage` / `notePost` / `noteComment`), so it grows as
  content is seen. **Index older messages** (Settings → Your data) fetches and decrypts what this device
  hasn't opened yet, in the background, with progress and Stop, text only, slower while Data Saver is on
  (after asking), waiting while offline (`lib/search/backfill.ts`). At most 30,000 items; the oldest leave first.
- **Encrypted at rest.** IndexedDB `kw-search`. Each record is an XChaCha20-Poly1305 blob under
  `HKDF(AMK, "kithwall/v1/search-index")` (`deriveSearchKey`), bound to the account, padded to 64-byte steps.
  The record's name is `HKDF(searchKey, "kithwall/v1/search-record/<id>")` (16 bytes), so storage holds no
  message, post or chat id in the clear, and an edit or unsend lands on the same record. A copy of the device
  shows how many records there are and roughly how long each is, nothing else. The decrypted copy lives in
  memory only while the app is unlocked (locking reloads the page).
- **Matching** (`lib/search/text.ts`): a prefix tokeniser over folded text. Folding ignores case and accents,
  Arabic harakat and tatweel, unifies the letters Arabic, Persian and Urdu keyboards write differently
  (ي ى ی, ك ک, ه ہ ھ ة, the alef forms), reads Arabic-Indic, Persian, Devanagari, Bengali and full-width
  digits as the same number, keeps Hindi and Bengali vowel signs but drops the nukta, and drops invisible
  characters. Every word of the query must start a word of the text; in scripts written without spaces
  (Chinese, Japanese, Thai…) and in Arabic script (attached articles and prepositions) a query word is found
  anywhere inside the text. Results are newest first, with the matches marked.
- **Screens.** Messages: the search field also lists matching messages across chats; inside a chat, "Search in
  this chat" (header, or Chat details on narrow screens); a result opens the chat at that message
  (`/messages/<chat>?m=<message>`, older pages are loaded until it is there). Posts and comments:
  `/you/search` (from Home and You). Explore's account search is a different thing and unchanged.
- **Rules.** Hidden chats are indexed but left out of every result unless they are revealed right now (the
  same `useHiddenChats()` rule as the chat list). Disappearing messages and posts carry their expiry and
  leave when it passes (also swept once a minute). An edit replaces the record; an unsend removes it (live,
  or the next time that stretch of the chat is fetched: `reconcileMessages`); a deleted post takes its comments
  along; leaving a chat removes its messages; blocking or disconnecting from someone removes their posts and
  comments (their chat messages stay, as in the chat). The whole database is deleted on sign-out, by the
  panic wipe and the duress wipe, by "Delete the search index", and when **Search on this phone** (on by
  default) is switched off.
- **Limits.** Like everything decrypted on a device, the index is only as safe as the unlocked device and
  the account key (§8). Other people's devices keep their own index of what you sent them until they delete
  it; unsending and expiry remove it there the same way. Not indexed: comments on album photos, stories,
  time capsules, and text inside pictures.
- **Tests.** `lib/search/text.test.ts` (15: folding per script, matching rules, highlighting back onto the
  original text, excerpts), `lib/search/store.test.ts` (10, against an in-memory IndexedDB: nothing readable
  at rest, padding, the same key and account needed to read it back, edits and unsends, removal rules, expiry,
  destroy and wipe), `packages/crypto/test/keys.test.ts` (the key and record-name derivation). Browser run
  (Playwright, system Chrome, local build, 2026-11-11): posts found after being seen, "Index older messages",
  Arabic-keyboard and unvowelled queries, Hindi without nukta, Chinese inside a sentence, no request or socket
  frame containing a query, opaque records in IndexedDB, jump to a message from the list and inside a chat,
  edit and unsend, hidden chat left out until revealed, delete / switch off / sign-out.

## 15. Blur faces before posting

Status: implemented 2026-11-11 · code `lib/photo/*`, `components/photo/BlurEditor.tsx`

In the post composer and on chat attachments, every picked photo has **Blur faces**. Opening it looks for
faces on the device and covers each one; tapping a face shows it again; dragging on the photo (or "Add a
box") covers anything else. Number plates, documents, screens and house numbers are **not** found
automatically, and the screen says so.

- **Destructive.** A covered box is replaced in the pixels by a mosaic of at most 6 cells along its longer
  side, each filled with its average colour (`lib/photo/blur.ts mosaic`). The result is encoded as a new JPEG
  on the device and replaces the picked file, so the existing re-encode → encrypt → upload path only ever
  sees the covered picture; the original never leaves the device.
- **Detection, on the device only.** The browser's `FaceDetector` where it exists and works; otherwise a
  self-hosted detector: our own TypeScript implementation of "pico" (pixel-intensity comparisons in decision
  trees, arXiv:1305.4537) with its trained face cascade (`public/models/pico/facefinder.bin`, 240 kB, MIT,
  SHA-256 checked before use). It is fetched from the app's own origin only when someone opens the tool. No
  WebAssembly and no change to the Content-Security-Policy were needed. Alternatives weighed: MediaPipe's
  runtime is a 14.6 MB WASM file, BlazeFace through TensorFlow.js about 1.5 to 2 MB of code in four packages.
  The cost of the small detector: it finds faces looking towards the camera; turned, tilted, small or partly
  hidden faces can be missed. The screen says "check the photo", and the manual boxes cover the rest.
- **Accessible.** Every box is a button in reading order: a face is a toggle; an own box moves with the arrow
  keys, resizes with Shift + arrows, and goes with Delete or its Remove button. Works with touch and at 320 px.
- **Tests.** `lib/photo/blur.test.ts` (15): the mosaic leaves at most cells × cells colours, fills with
  averages, gives the same result for different originals with equal cell averages, box arithmetic; the
  cascade file's hash and parse, a face found where it is in a public-domain portrait
  (`lib/photo/fixtures/portrait-160.grey`) and in its mirror image, nothing found in flat, random and gradient
  pictures. Browser run (2026-11-11): face found and covered, tap to show, drag / keyboard / Add a box, 320 px,
  and the photo stored and decrypted again is the covered one (post and chat attachment). Not yet tried in the
  Android WebView or on a real phone's camera photos.
