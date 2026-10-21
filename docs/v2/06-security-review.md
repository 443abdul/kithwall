# Kithwall 2: pre-launch security review

Scope: branch `v2` at HEAD `6a379c8` (the working tree had uncommitted launch-prep edits from another process
during the review: README, package.json licence fields, `supabase/launch/`, SECURITY.md, etc. Those were not
reviewed except for a secrets check of `supabase/launch/`). Date: 2026-10-21.

Method: full read of the 23 migrations, all 28 API routes, `proxy.ts`/`next.config.ts`, `packages/crypto`,
`lib/keys`, `lib/safety`, calls, push, service worker, export, native shells and CI. Attacker-role SQL probes
against the **local** Supabase (`authenticated` role + forged JWT claims, every probe inside
`BEGIN … ROLLBACK`; 0 leftover rows verified). Live probes against a local dev server on port 3081 (stopped
and cleaned). `packages/crypto` tests: 136/136 pass. `npm audit --omit=dev`: 0 vulnerabilities. Full git
history scan (all local refs, tags, the `backup/pre-author-rewrite` branch, and all 8 GitHub `refs/pull/*`
refs fetched into a scratch repo).

Paths for migrations are relative to `supabase/migrations/`; web paths are relative to `apps/web/src/`
unless written in full.

## 1. Executive summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 11 |
| Low | 15 |
| Info | 12 |

**No secrets were found in the current tree or anywhere in git history** (details in §7). The public
crypto primitives, envelope format, passkey ceremonies, SSRF guards, push crypto, CSP/headers, cron/hook
authentication and storage policies are in good shape.

The serious problems are in **key distribution and identity trust** (who may hand you a key, and whether a
contact's identity key can change silently) and in **two database exposure paths** (Realtime DELETE events
and unrestricted conversation creation). For an E2EE product aimed at at-risk users these are launch
blockers.

### Launch blockers

1. **K1 (Critical)**: any conversation member (or the operator) can plant `audience_keys` for future epochs,
   and the client adopts them. A removed member keeps reading the chat; the operator can inject keys.
2. **K2 (High)**: identity keys (`profiles.sign_pub`/`kx_pub`) can be replaced by any session of the account
   (or the operator) and unverified contacts accept the new key silently. Email takeover means impersonation.
3. **D1 (High)**: Realtime broadcasts DELETE events on `friendships`, `pokes`, `likes`, `audience_keys` and
   `message_reactions` to every subscriber regardless of RLS, leaking the social graph, blocks, likes and
   circle membership to any signed-in user.
4. **D2 (High)**: any user can create a conversation, add any non-blocking user as an active member, then
   message, call and ring them, bypassing `requests_from = 'nobody'`.
5. **W1 (Medium, trivial fix, phishing risk to at-risk users)**: open redirect via `/signin?next=/%09/evil`.

Strongly recommended before launch (Medium): W2 (passkey add with bearer only), D3 (profile enumeration),
W3 (passphrase-account enumeration), W4 (recovery denial of service and spoofed friend prompts),
N1 (iOS iframes reach native plugins), P1 (privacy overclaims).

## 2. Findings: Critical and High

### K1. Critical: audience/conversation key injection (malicious member or operator)

Probe-confirmed.

- **Evidence**
  - `20261017000002_graph.sql:262-274`: policy "deliver keys to members" lets any active member of a
    conversation insert `audience_keys` rows for **any member and any epoch**. Nothing requires
    `epoch <= current_epoch` or that the sealer is the owner. `20261018000400_messages_chat.sql:5-8` says
    the owner is the only key authority, but nothing enforces it.
  - `lib/keys/keyring.ts:71-87` (`ingest`) only checks that the signature verifies against `sealed_by`.
    There is no check that `sealed_by` is the audience owner or admin. The first key seen for an
    (audience, epoch) wins (`:75`). `current()` (`:94-101`) loads before `ensureOwn()`, and `ensureOwn`
    (`:107-113`) reuses an already-loaded key instead of generating its own. `storeFor` (`:119`) swallows
    the 23505 unique violation, so a planted row survives the owner's own delivery.
  - Probe: a non-owner member inserted keys for epochs 2, 7 and 99, addressed to the owner and another
    member, with `current_epoch = 1`: `INSERT 0 2`.
- **Exploit**
  - Malicious member M pre-plants keys sealed by M for epochs N+1…N+k to every member, the owner included.
    The owner removes M and rotates; every client (owner included) adopts M's planted key for the new epoch.
    M, or anyone holding the ciphertext (operator, later breach), reads post-removal messages. This defeats
    "removal rotates the key".
  - Operator / anyone with service-role DB access: create a puppet profile, replace or pre-plant rows
    (including a user's own Friends/self audience key). The victim's client accepts it and encrypts under
    the attacker's key. Safety numbers do not detect it. This contradicts `docs/03-spec.md` §3.6 ("so the
    server can't inject a key of its own").
- **Fix**
  - Client: accept a key only if `sealed_by` is the audience owner (friends/self/list) or a signed
    owner/admin record for that epoch (group/conversation). Never adopt a key for an audience you own unless
    you sealed it yourself. Treat a duplicate row on delivery as an error, not success.
  - DB: `with check (epoch <= kw.audience_current_epoch(audience_id))`. For `kind='conversation'` require
    `sealed_by = owner` (or the member rotating, if rotation is delegated). Allow only the owner (or admin)
    to insert for epochs above the current one, and only as part of the rotation.

### K2. High: identity keys are mutable and not pinned by clients

Probe-confirmed.

- **Evidence**
  - `20261017000002_graph.sql:99-116`: profiles UPDATE policy plus `kw.profiles_guard` allow changing
    `sign_pub`/`kx_pub`. Probe: an **aal1** session updated both with `UPDATE 1`. No `key_changes` row,
    signature by the old key, or proof of key is required.
  - Clients read peer keys straight from `profiles` (`lib/keys/keyring.ts:76-81`, `engine.ts:218-222`,
    `content.ts:124`, `messages.ts:426`). Key-change warnings exist only for contacts the user verified
    manually (`lib/transparency/verified.ts:150-186`). Spec §2 claims key changes are "signed by the
    previous key and announced in-app".
- **Exploit**: an attacker with only a session (v1 email reset or magic link, stolen refresh token, briefly
  unlocked device) or the operator swaps the victim's keys. Every unverified friend then accepts posts and
  messages forged in the victim's name, and new epoch/conversation keys are sealed to the attacker, so the
  attacker reads new content. This breaks the claim that taking over the email gives no keys.
- **Fix**
  - DB: make `sign_pub`, `kx_pub` and `key_version` immutable except via a SECURITY DEFINER RPC that
    requires a `key_change` record signed by the old signing key plus a fresh proof of key (the
    `key_challenges` flow already exists). Require aal2 where MFA is enrolled.
  - Client: TOFU-pin every contact's `sign_pub` in the vault. On change, require a valid `vouchedChain`
    signed by the pinned key; otherwise warn prominently and stop sealing to the new key until the user
    accepts.

### D1. High: Realtime DELETE events bypass RLS and leak the social graph

Code-confirmed. No live websocket test, because that needs persistent writes; Supabase documents that RLS
is not applied to DELETE events.

- **Evidence**
  - Local `realtime.apply_rls`: `if not is_rls_enabled or action = 'DELETE' then visible_role_sub_ids = …`.
    With default replica identity the old record carries the primary-key columns.
  - Published tables whose primary keys are relationships:
    - `friendships(user_a, user_b)`
    - `pokes(from_id, to_id)`
    - `likes(target_kind, target_id, user_id)`
    - `audience_keys(audience_id, epoch, recipient_id)`
    - `message_reactions(message_id, user_id)`
  - Publication entries: `20261017000004_comms_recovery_moderation.sql:397-399`,
    `20261018000500_community.sql:330`, `20261022000500_messages_privacy_reactions.sql:226`,
    `20261024000100_ephemeral.sql:467-472`.
  - Frequent deletes: unfriend, declined request, block (`graph.sql:84-92` deletes the friendship), expiry
    and deletion of posts (likes removed in `ephemeral.sql:356-364`).
  - The app itself subscribes to `friendships` with no filter (`keyring.ts:38`).
- **Exploit**: any signed-in user subscribes to `postgres_changes` DELETE on these tables and passively
  learns who was connected to whom, who blocked or unfriended whom, who liked which post, and which members
  hold keys to which circle or chat. For activists this is a social-graph leak to other users, not only to
  the operator.
- **Fix**: drop these tables from `supabase_realtime`. Push the changes instead through private Broadcast
  topics (`inbox:<uid>`) from triggers via `realtime.send`, which RLS on `realtime.messages` already
  protects. Keep the publication only for tables keyed by opaque ids whose DELETE payload reveals nothing.
  Enable "private channels only" for Realtime in production (`private_only` is `f` locally).

### D2. High: strangers can force anyone into a conversation and ring them

Probe-confirmed.

- **Evidence**
  - `20261017000002_graph.sql:209-221`: an audience owner may insert any non-blocking user as
    `status='active'`.
  - `20261022000100_circles.sql:72`: the membership guard returns early for kinds other than group and
    event, so conversations get no friend or request check.
  - `may_request` applies to friendships only (`messages_privacy_reactions.sql:138-139`).
  - Probe: stranger A, with victim B set to `requests_from='nobody'`, created a conversation, added B as
    active, inserted a message, and `start_call` returned OK. `kw.shares_conversation(A,B)` and
    `kw.may_signal(B)` returned true, so ring and inbox pushes are allowed (`20261025000100_calls.sql:72-78`,
    `messages_chat.sql:147-151`). A could also insert notifications to B, including
    `type='recovery_request'`.
- **Exploit**: unsolicited messages, calls, ringing and push notifications from throwaway accounts to
  at-risk users, plus phishing via fake recovery notifications. The only prerequisite is B's UUID, which
  every signed-in user can read (D3). B's only defence is blocking each new account after the fact.
- **Fix**
  - Adding someone other than yourself to a conversation must require `kw.is_friend(owner, member)` or
    `kw.may_request(owner, member)`. Otherwise insert them as `status='invited'` (a message request) that
    cannot be rung or pushed until accepted.
  - Gate `notifications` inserts and `may_signal`/ring on the same rule.

## 3. Findings: Medium

### W1. Medium: open redirect on sign-in (`next` parameter)

Confirmed by code and by testing how Node parses the URL; not run in a browser.

- **Evidence**: `components/onboarding/SignIn.tsx:24-27`. `safeNext` rejects only values not starting with
  `/`, or starting with `//` or `/\`. `"/\t/evil.com"` passes, and `new URL("/\t/evil.com", origin)`
  resolves to `https://evil.com/`; `/\n/` behaves the same. The value is passed to `router.replace(next)`
  immediately when already signed in (`:51`) and after every sign-in path (`:69, 73, 94, 100, 180`). Next
  then does a full cross-origin navigation.
- **Exploit**: `https://kithwall.com/signin?next=%2F%09%2Fevil.example` lands an activist on a lookalike
  page asking for their passphrase or recovery phrase.
- **Fix**: reject any control characters or backslashes, then
  `const u = new URL(raw, location.origin); if (u.origin !== location.origin) fallback;` and navigate to
  `u.pathname + u.search + u.hash`.

### W2. Medium: adding a passkey (or enabling passphrase) needs only a bearer token

Confirmed by code.

- **Evidence**: `app/api/auth/passkey/add/options/route.ts:13-48` and `add/verify/route.ts:10-33` check only
  `callerFromRequest` plus `needsMfa`. `add_passkey` (`20261021000100_passkeys.sql:197-221`) records no
  security event and sends no notice. `passphrase/enable` has the same pattern.
- **Exploit**: a briefly stolen access token (XSS, token read from localStorage, seized unlocked device) is
  turned into a permanent sign-in credential. That gives the attacker metadata, graph, ciphertext and the
  ability to act as the user. Combined with K2 it also gives them identity-key replacement.
- **Fix**: require proof of key (sign a fresh `key_challenges` nonce with the identity key, as
  delete-account already does) and aal2 where enrolled. Send a content-free notice to all devices and the
  notice email on every credential added.

### D3. Medium: every signed-in user can list all profiles

Probe-confirmed.

- **Evidence**: `20261017000002_graph.sql:95-96`: anyone not blocked can SELECT every `profiles` row. The
  probe read 12 non-discoverable profiles with `id`, `username`, `created_at`, `status`, `suspended_until`
  and `key_version`.
- **Exploit**: scraping every handle, account age and moderation status. `discoverable=false` is
  meaningless, and the UUIDs this exposes are what D2 needs. Brief principle 4 promises a "profile visible
  only to connections".
- **Fix**: replace the open SELECT with an exact-handle lookup RPC, plus row access for connections,
  co-members and discoverable profiles. Hide `status`, `suspended_until` and `created_at` from others.

### W3. Medium: passphrase lookup reveals passphrase accounts and their user id

Confirmed live.

- **Evidence**: `app/api/auth/passkey/passphrase/lookup/route.ts:17-21, 40-44`.
  - The real synthetic address is `u<uuid without dashes>@id.kithwall.invalid` (`passkey-shared.ts:36-40`).
    The decoy is 32 hex characters of HMAC output.
  - UUIDv4 version and variant nibbles distinguish the two (a decoy matches by chance about 1 time in 64),
    and the embedded id equals the public profile id (D3), which settles it.
  - Live: a known passphrase account returned exactly its user id.
  - The decoy HMAC key falls back to the constant `'kithwall'` when ALTCHA_HMAC_KEY and SUPABASE_SECRET_KEY
    are unset (`:18`).
- **Exploit**: anyone can enumerate which handles are protected only by a chosen passphrase and target them
  with online guessing via the GoTrue password grant. That grant is limited per IP only
  (`sign_in_sign_ups = 30` in `supabase/config.toml`), with no per-account lockout.
- **Fix**
  - Use a synthetic address that does not contain the user id, e.g. `u<HMAC(server key, userId)>`.
  - Make decoys indistinguishable in shape.
  - Add a per-handle rate limit on password sign-in (proxy the grant through a server route).
  - Fail closed if no HMAC key is configured.

### W4. Medium: account recovery can be blocked, and friends get spoofed "help me recover" prompts

Code-confirmed. This merges the route and SQL findings.

- **Evidence**
  - `app/api/recovery/friends/start/route.ts:16-30`: no auth, no proof-of-work, only a per-instance
    in-memory IP limiter.
  - `start_handle_recovery` (`20261023000100_handle_recovery.sql:43-54`) allows 3 requests per account per
    24 h and counts every request, cancelled ones included.
  - Each request notifies every trusted friend with `actor_id = owner`.
  - `/api/recovery/account` (`route.ts:13-23`) allows 12 challenges per account per hour, also with no
    proof-of-work.
  - `friends/status` returns the friend count and threshold.
- **Exploit**: an adversary files 3 junk requests a day for a target's handle. If the target loses their
  devices, they can never start trusted-friend recovery, and they cannot cancel without a device. Each junk
  request also reaches the friends as if the owner asked, which sets up social engineering. The recovery-key
  path can be exhausted hourly in the same way.
- **Fix**
  - Require ALTCHA proof-of-work on both start routes.
  - Rate-limit per requester (IP tag in the DB) as well as per account; exclude cancelled requests; let a new
    request supersede stale ones.
  - Word the notification as "someone started a recovery for @owner; only help if they contacted you
    directly".
  - Do not return the friend count or threshold before a request is accepted.

### D4. Medium: reports can be forged against group, event, page and profile targets

Probe-confirmed.

- **Evidence**: `20261017000004_comms_recovery_moderation.sql:286-287, 291-317`. The guard has no branch for
  group, event or page. It neither validates visibility nor overwrites the reporter-supplied
  `target_owner_id` and `stored_envelope`. The profile branch keeps a reporter-supplied `stored_envelope`.
  `20261018000100_auth_safety.sql:186-203` leaves `stored_meta` null for these kinds. Probe: a report with
  `target_kind='group'`, a random id, `target_owner_id=<victim>`, `reason='child_safety'` and fabricated
  "evidence" was accepted.
- **Exploit**: framing an innocent user so that moderators suspend or ban them, with fabricated evidence
  presented as server-captured.
- **Fix**: for every kind, require `kw.can_read_target`, derive `target_owner_id` server-side, and force
  `stored_envelope = null` unless the server copied it from a real row.

### N1. Medium: iOS, third-party embed iframes can call every native plugin

Confirmed from code.

- **Evidence**
  - Capacitor iOS registers `window.webkit.messageHandlers.bridge` for all frames
    (`node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift:22`). The handler
    (`:192-216`) does not check `frameInfo.isMainFrame` or the frame's origin; `forMainFrameOnly: true`
    (`JSExport.swift:20`) only limits where the JS wrapper is injected.
  - `Kithwall.swift:96` allows iframe navigations.
  - Embeds use `sandbox="allow-scripts allow-same-origin"` (`components/posts/Media.tsx:203-206`) for
    YouTube-nocookie, Vimeo, Dailymotion, Streamable and TikTok (`lib/embeds.ts:32-39`).
  - Android is not affected: `MessageHandler.java:26-36` restricts the bridge to the app origin and the
    main frame.
- **Exploit**: a compromised player, or ad script inside it, posts raw bridge messages. It cannot read the
  results, but it can:
  - clear or overwrite the remembered key and PIN record, or reset the PIN attempt counter
    (`KithwallSecure`);
  - un-hide hidden chats so their previews appear in notifications (`KithwallPush.clearHidden`);
  - unregister push, disable the screenshot shield, open external URLs, or trigger passkey prompts.
  - Needs verification: whether it can also set or clear cookies through `CapacitorCookies`.
- **Fix**: subclass `WebViewDelegationHandler` and drop messages unless `message.frameInfo.isMainFrame` and
  the security origin is the app origin. Alternatively, open embeds externally on iOS.

### N2. Medium: staging app builds embed the Vercel protection-bypass secret and are uploaded as CI artifacts

Confirmed.

- **Evidence**: `apps/mobile/capacitor.config.ts:22,36` puts `x-vercel-protection-bypass=<secret>` in
  `appStartPath`. `android.yml:126` and `ios.yml:241` fill it from `secrets.VERCEL_AUTOMATION_BYPASS_SECRET`
  for env=staging. The builds are uploaded with `upload-artifact` (`android.yml:174-181`, `ios.yml:313-318`).
- **Exploit**: once the repo is public, anyone signed in to GitHub can download the artifact and read the
  secret from `capacitor.config.json`, unlocking the protected staging deployment.
- **Current state (checked with gh)**: the repo is PRIVATE. The only stored artifact is
  `kithwall-android-production-1`, so no staging build has run and nothing has leaked yet.
- **Fix**: do not embed the bypass in shipped builds (use a separate revocable token, or no protection for a
  dedicated test deployment), and do not upload staging artifacts from a public repo.

### C1. Medium: "non-extractable" device keys do not protect data at rest

Confirmed from browser behaviour; a disk-image test would close it.

- **Evidence**: `lib/keys/device.ts:4-6` and `lib/safety/pin.ts:10-12` claim a copied database is useless.
  Chromium and Firefox persist the raw key bytes of non-extractable `CryptoKey`s in the IndexedDB files.
  "Remember this device" defaults to on for passkey sign-ins (`session.ts:215`).
- **Exploit**: with an imaged or seized device:
  - With "remember", the AMK is recovered directly.
  - With an app PIN, the PinWrap can be brute-forced offline. About 10^6 Argon2id (64 MiB) evaluations
    takes hours on a many-core machine, not the "days to weeks" in `docs/v2/03-safety.md:152-156`.
  - The attempt limiter and the duress/decoy separation are bypassed, and the attacker can tell the real
    PIN from the duress PIN.
- **Fix**
  - Correct the claims in comments, docs and UI.
  - Default "remember" to off on the web.
  - Steer at-risk users to the native apps (Keystore/Keychain-backed).
  - Consider a server-assisted PIN limiter (a server-held pepper released only after a rate-limited proof).

### C2. Medium: chat link previews send typed URLs to the server automatically

Confirmed.

- **Evidence**: `components/messages/ChatComposer.tsx:81-95` calls `fetchLinkPreview`
  (`lib/feed/linkPreview.ts:45-55`) 700 ms after typing stops, with the user's bearer token. This happens
  even for drafts that are never sent. Privacy policy §4.8 discloses previews for posts only, and there is
  no setting to turn them off.
- **Exploit**: the server (and its logs or hosting provider) learns which URLs a user is discussing in
  private chats, tied to their account.
- **Fix**: make chat previews tap-to-fetch, or off by default with a setting; disclose them.

### P1. Medium: privacy overclaims vs reality

| Claim | Where | Reality |
|---|---|---|
| "Profile visible only to connections" (Safe by default) | `docs/v2/00-brief.md` principle 4 | Any signed-in user can list every profile's handle, id, created_at and moderation status (D3). |
| "Blocked people can't see … anything you share, message you" | `en.json settings.privacy.blockedBody`; `docs/03-spec.md:358` | A blocked person keeps reading existing 1:1 history and, in shared group chats, new messages. Message reads check membership only (`comms_recovery_moderation.sql:48-49`). |
| "Minimal metadata" / "We can't see it" | brief §2–3 | Other users can see graph changes via D1. Chat link previews reveal URLs (C2). |
| A copied device database is useless | `lib/keys/device.ts`, `03-safety.md:152-156` | Not true on web browsers (C1). |
| Panic wipe clears WebView cookies and cache (native) | `lib/native/wipe.ts:8-9` | Nothing clears them (N6). |
| Key changes are "signed by the previous key and announced in-app" | `docs/03-spec.md` §2 | Not enforced (K2). |
| "Our own tables never store IP addresses" | `en.json transparency.logs.supabaseBody` | `webauthn_challenges.ip_tag` is an HMAC of the IP under a daily key the operator holds. An IPv4 tag is reversible by brute force over 2^32. This is disclosed in the data map as "hashed", but the sentence should say "a keyed hash, rotated daily". |

**Fix**: fix the underlying issues (D1, D3, C2) or reword the claims. The brief, the transparency page and
the landing copy should only state what is true today.

## 4. Findings: Low

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| L1 | Anyone can add themselves as `requested` to another user's conversation or list audience (needs its UUID). They then see the `audiences` row, trigger `rekey_needed`, and make `shares_audience` true for notifications. Self-promotion is correctly refused. | `graph.sql:214`, `circles.sql:72`, `messages_chat.sql:19-30`, `comms_recovery_moderation.sql:92-94` (probe) | Allow `requested` only for `kind='group'` with closed privacy. |
| L2 | Moderators can undo admin bans, suspend admins, and edit a report's `target_owner_id`/`target_kind`. | `comms_recovery_moderation.sql:344-360` | Make ban restore and actions against staff admin-only; make report target columns immutable. |
| L3 | The inviter can reset an invite's `uses` and `expires_at`. `redeem_invite` skips the `is_active`, block and `may_request` checks. | `comms_recovery_moderation.sql:168-186` | Make these columns immutable after insert; add the checks. |
| L4 | No storage quota. Objects can be uploaded with no `media_objects` row (30 MB each). | `comms_recovery_moderation.sql:389-390` | Per-user quota, and garbage collection of orphaned objects. |
| L5 | Blocking does not cut off conversation reads (see P1). | `comms_recovery_moderation.sql:48-49` | Add a block check to message SELECT for 1:1 chats, or document the behaviour. |
| L6 | Unauthenticated IP rate limits are in-memory per instance and trust the first `X-Forwarded-For` entry. On self-hosted setups behind an appending proxy, every IP limit can be bypassed. | `lib/auth/passkey-server.ts:85-88`; `handle/route.ts:12`, `passphrase/lookup/route.ts:14`, `recovery-server.ts:12` | Configure the trusted proxy hop; keep the limits in the DB or a KV store. |
| L7 | Scheduled deletion skips the MFA check. Whoever controls the email of a v1 account with TOTP can schedule deletion, and the notice goes to that same inbox. | `account/delete/route.ts:20-25`, `deletion-request/route.ts:12-19`; `request_account_deletion` lacks `kw.mfa_ok()` (`auth_safety.sql:77-88`) | Require aal2 when enrolled; notify all devices and the notice address. |
| L8 | `siteOrigin()` falls back to the request `Host` header when `NEXT_PUBLIC_SITE_URL` is unset, and that origin goes into links in emails. | `lib/server.ts:121-123`, `notice-email/route.ts:46` | Refuse to send mail in production if the variable is unset. |
| L9 | The vault and edited content can be rolled back: the vault blob has no version in its AAD, and `resealEnvelope` keeps the header, so the server can replay older versions. | `lib/settings.ts:102,116` | Add a monotonic version to the AAD/signature and reject regressions. |
| L10 | Hidden-chat conversation ids are left in plaintext localStorage (`kw.eph.suggest.<id>`, `kw.read.<id>`, voice-played list). | `Ephemeral.tsx:90-95`, `messages.ts:402-411` | Keep them in the vault or in memory. |
| L11 | `photoContentKey` unwraps without verifying the signature. | `lib/photos.ts:117-120` | Pass `signPub`. |
| L12 | The server can run an offline dictionary attack on passwords and passphrases: it sees an HKDF of Argon2id(password, salt), and the salt is derived from the email or handle. The policy floor is zxcvbn 3 plus 10 characters. | `packages/crypto/src/password.ts:4-8`, `lib/auth/password.ts:8-23` | Document it; raise the floor to zxcvbn 4; consider OPAQUE later. |
| L13 | GitHub Actions are pinned to tags, not SHAs, in jobs that hold signing keys. The Supabase CLI uses `version: latest`. `npm ci` runs install scripts. | `.github/workflows/android.yml`, `ios.yml` | Pin to SHAs; separate the signing job behind a protected environment; `persist-credentials: false`. |
| L14 | Android release builds silently fall back to the debug key. No Gradle wrapper checksum or validation. | `apps/mobile/android/app/build.gradle:21,68`; `gradle-wrapper.properties` | Fail release builds without the keystore; add `distributionSha256Sum` and `wrapper-validation`. |
| L15 | Android `MainActivity` is exported and loads any same-origin `kw_url` extra from any app. `kw_tag` lets other apps cancel Kithwall notifications. Panic wipe does not clear WebView cache or cookies (N6, see P1). | `AndroidManifest.xml:106`, `MainActivity.java:63-67`, `Notifier.java:66-86`; `lib/native/wipe.ts:8-29` | Accept `kw_url` only with a per-install token or via a non-exported trampoline; add a native clear of WebView data and call it from the wipe. |

## 5. Info

- I1. `anon`/`authenticated` hold TRUNCATE/TRIGGER/REFERENCES on public tables (Supabase defaults). They are
  not reachable through the Data API; revoke for defence in depth.
- I2. Realtime `private_only` is off on the local tenant. The client always uses `private: true`; enable
  "private channels only" in production.
- I3. `kw.rate_limit` counts and then inserts without a lock, so concurrent bursts can slightly exceed
  limits (`core.sql:93-104`).
- I4. Released handles can be re-registered by someone else (impersonation). Consider a cooldown.
- I5. UnifiedPush endpoint SSRF guard uses an IPv6 blocklist rather than allowing only `2000::/3`, so
  `::7f00:1` and `3fff::/20` are not refused (`lib/push/endpoint.ts`). Low practical risk; reuse the
  link-preview allowlist.
- I6. Chat signals are signed with the proof-of-key function `signChallenge`
  (`lib/chat/signals.ts:40,234`). Safe today because of the distinct prefix; give it its own domain.
- I7. Default auto-lock is "never" (`applock.ts:233`), while spec §3.13 says 30 minutes. The AMK lives on
  the main thread, not in a Worker as the spec says. Decoy mode leaves the Supabase session token in
  localStorage.
- I8. Group-call frame keys are shared by all conversation members and are not rotated when someone leaves
  the call (documented in `04-calls.md`).
- I9. FLAG_SECURE ("block screenshots") is off by default. Consider enabling it in Safety setup for at-risk
  users.
- I10. iOS Keychain items saved without an access group land in the shared group, so the notification
  extension can read them. `aps-environment` is `development` in `App.entitlements`; check the release
  export.
- I11. Dev-only `npm audit` findings (8: braces/micromatch via eslint-config-next, uuid/xcode via
  @capacitor/cli). Build-time only; nothing ships.
- I12. Repo metadata that will become public: the production Supabase project ref
  (`uvuojqziktbwxkjzeiar.supabase.co`) and its **publishable** key appear in docs. Both are public by
  design. Commit author emails `[personal email]` (21 commits) and `[personal email]`
  (7 commits on `main`/`v2`) are in history. The local-only branch `backup/pre-author-rewrite` carries more
  commits with the second email; do not push it (`git push --all` would).

## 6. Verified OK

**Database**

- RLS is enabled on all 56 public tables, and a migration asserts this.
- Every SECURITY DEFINER function sets `search_path = ''`. The `kw` schema is not exposed through the API.
- Server-only RPCs are not executable by anon or authenticated (checked with `has_function_privilege`).
  Only `transparency_data_map` (a static map) is anon-executable.
- Server-only tables have no client grants.
- `passkeys`, `key_bundles`, `vault` and push devices are readable by their owner only.
- `requests_from` is enforced for connection requests. Role escalation is blocked by
  `audience_members_guard`. The epoch advances by at most 1 per update.
- Scheduled, expired and hidden content is covered by restrictive policies; media access follows the parent
  row.
- Server notices and unsend go through `kw.trusted_write`.
- Realtime `call:`, `ring:` and `inbox:` topics are broadcast-only. `ring:` and `inbox:` are owner-only.
  `call:` requires active membership and refuses blocked 1:1 chats.
- Storage: private bucket, own-folder uploads, no UPDATE (no overwrite), reads through `can_read_media`.
- `passkey_used` refuses counter rollback. `remove_passkey` keeps the last unlock method. pg_cron jobs run
  fixed SQL.

**Server routes**

- All authenticated routes use strict Bearer verification via `getUser`. There are no cookie sessions, so
  there is no CSRF surface. Live probes of cron, dispatch, link-preview, turn, push/test, account/delete and
  the hook returned 401 or 403.
- Cron secret: at least 16 characters, compared timing-safe, fail-closed. Dispatch secret: at least 32
  characters, compared as hashes in constant time.
- The before-user-created hook uses Standard Webhooks HMAC with a ±5 minute window. ALTCHA signatures are
  single-use.
- Link-preview SSRF:
  - The check runs at connect time on every redirect hop.
  - Only `2000::/3` is allowed for IPv6, which also covers IPv4-mapped and NAT64 addresses.
  - Decimal IP forms are normalised. DNS rebinding is refused if any resolved address is private.
  - Ports 80/443 only, at most 4 redirects, size caps, magic-byte checks on images.
- Web push uses an endpoint allowlist. RFC 8291 is implemented correctly (`lib/push/crypto.ts`), and APNs
  and FCM carry only ciphertext.
- TURN credentials require auth, last 1 hour, and are rate-limited and quota'd.
- Passkeys:
  - Challenges are 32 random bytes, last 5 minutes, and are single-use (consumed atomically by intent). The
    `add` challenge is bound to the user.
  - Origin and rpID come from config in production. Android `apk-key-hash` origins come only from
    `ANDROID_CERT_SHA256`.
  - User verification is required. PRF output is rejected server-side.
  - Algorithms are ES256, EdDSA and RS256 only, with attestation `none`.
- Recovery `finish` requires an Ed25519 proof of key over a single-use nonce in its own domain.
- Notice email: 256-bit token stored hashed, valid 24 hours, single-use. Confirmation is POST-only, so mail
  scanners cannot confirm.
- Immediate account deletion requires proof of key and aal2.
- Headers:
  - Nonce + `strict-dynamic` CSP with `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`.
    No `unsafe-eval` in production.
  - HSTS with preload, COOP same-origin, CORP same-site, restrictive Permissions-Policy, nosniff,
    Referrer-Policy no-referrer.
  - Remaining weak spots: `style-src-attr 'unsafe-inline'` is always on, and Trusted Types are not enforced.
- There are no server-side open redirects. Error messages and logs carry no tokens or payloads.

**Client crypto**

- XChaCha20-Poly1305 with random 24-byte nonces. Strict Ed25519 (`zip215: false`). X25519 rejects
  low-order points.
- Argon2id: floor of 64 MiB with t=3, and caps on server-supplied parameters (no downgrade).
- Envelopes: header AAD on both `wk` and `ct`; the signature is verified before decryption; unexpected
  fields are rejected.
- `seal` binds the context and the recipient.
- Chunked file format binds the index, the final flag and the file id.
- Constant-time RK commitment check. Shamir share validation.
- PRF output never leaves the device; the wrap AAD is bound to the user and the credential.
- Call signalling is signed and bound to the conversation and epoch, restricted to members, with a 90 s
  replay window plus id dedupe. DTLS fingerprints are signed. Frame E2EE drops unsealed frames.
- The service worker has no fetch handler or caches.
- XSS: no `dangerouslySetInnerHTML`, `innerHTML` or `eval`. Every user link goes through `safeHref`.
  Embeds are allow-listed and sandboxed. Markdown is used only for the bundled legal docs.
- Export is decrypted on the device and the HTML is escaped.
- Wipe covers IndexedDB, localStorage/sessionStorage, Cache Storage, the service worker, the push
  subscription and the native secure store.

**Native**

- Capacitor:
  - A single https origin, `allowNavigation: []`, no cleartext, no mixed content.
  - WebView debugging off. The Android bridge is main-frame and app-origin only.
  - External navigation goes to the system browser; `intent:`, `file:` and `javascript:` links are blocked.
- Android:
  - Backups and device transfer are fully excluded. Only system certificate authorities are trusted.
  - Receivers and providers are not exported. App links are verified. Firebase analytics is off.
- Secure storage: Keystore AES-GCM (StrongBox when available) with biometric invalidation on re-enrolment;
  Keychain items are this-device-only.
- Native push decryption validates strictly, and lock-screen text is generic.
- iOS has no ATS exceptions and no custom URL schemes.

**CI**

- No `pull_request_target`. `permissions: contents: read`. No untrusted `${{ }}` inside `run:`.
- Fork PRs get no secrets. Keystore and Firebase files are deleted with `if: always()`.
- `npm audit --omit=dev`: 0 vulnerabilities in 92 production dependencies.

## 7. Secrets scan (current tree and full history)

- **Scope**
  - All 30 commits reachable from every local ref (`main`, `v2`, `backup/pre-author-rewrite`, tags
    `v1-classic`, `android-test-1`), about 11 MB of patch text.
  - All GitHub-only refs: the 8 `refs/pull/*/head` (all Dependabot) were fetched into a scratch bare repo
    and scanned the same way.
- **Patterns**: JWTs (`eyJ…`), `sb_secret_`, `sb_publishable_`, Stripe, AWS, Google API, GitHub and Slack
  tokens, Resend keys, PEM private keys, `postgres://user:pass@`, Supabase pooler and DB hosts, env-style
  `KEY=value` lines, secret/password/token/vapid/bypass assignments, 43-character base64url (raw
  EC/X25519/VAPID keys) and 64-hex strings. Also any file ever added matching `.env*`, `*.pem`, `*.key`,
  `*.p8`, `*.p12`, `*.jks`, `*.keystore`, `google-services.json` or `*.mobileprovision`.
- **Results**
  - **No secret keys, service-role keys, JWT secrets, DB passwords, VAPID private keys, signing keys or
    provider credentials anywhere in history.**
  - The only key-like hits are public test vectors: RFC 8291 `asPrivate`/`uaPrivate`, RFC 7748 and RFC 8032
    hex vectors, and HMAC test tags.
  - Also present: the production **publishable** key and project ref in docs (public by design, I12) and
    `sb_publishable_ci_placeholder`.
  - The only env file ever committed is `apps/web/.env.example`, with empty values in every version.
  - `apps/web/.env.local` exists locally and is correctly ignored (`apps/web/.gitignore:34`).
  - `.gitignore` covers native signing material. The untracked `supabase/launch/seed_v1_sample.sql` contains
    only synthetic test values (e.g. the well-known demo TOTP secret `JBSWY3DPEHPK3PXP`), so it is fine to
    commit.
- **Before flipping the repo public**
  - CI logs and artifacts become public too. Today there is one production Android artifact and no staging
    builds (N2).
  - Do not push `backup/pre-author-rewrite`.
  - Rotate `VERCEL_AUTOMATION_BYPASS_SECRET` if a staging build is ever run while the repo is public.

## 8. Recommended pre-launch fixes, in order

1. **K1**: restrict `audience_keys` inserts (epoch ≤ current; conversation keys only from the owner or
   rotator), and in `keyring.ts` accept only owner/admin-sealed keys and never adopt a foreign key for your
   own audience.
2. **K2**: make identity keys immutable except through a signed-key-change RPC with proof of key; add TOFU
   pinning and key-change warnings for all contacts.
3. **D1**: remove `friendships`, `pokes`, `likes`, `audience_keys` and `message_reactions` from the Realtime
   publication; deliver via private broadcast; enable private-only channels in production.
4. **D2**: require a friendship or an accepted message request to add someone to a conversation; gate
   ringing, pushes and notifications on it.
5. **W1**: same-origin check for `next` in `SignIn.tsx` (one-line fix).
6. **W2**: proof of key and notices for passkey add and passphrase enable.
7. **D3**: replace the open profiles SELECT with handle lookup plus connection-scoped reads.
8. **W4**: proof-of-work and per-requester limits on recovery start; reword the friend prompt.
9. **W3**: synthetic address without the user id, decoys of the same shape, per-handle password-grant
   limit.
10. **N1**: main-frame and origin check on the iOS bridge.
11. **D4**: server-derived report targets and evidence.
12. **C2, C1, P1**: chat previews opt-in; correct the at-rest and wipe claims; default "remember" off on the
    web.
13. **N2, L13, L14**: CI hardening before the repo goes public.
14. Remaining Low and Info items after launch.

## 9. Remediation status: data exposure and authorisation

Migrations `20261028010100`…`010600_authz_*.sql`; regression tests in `supabase/tests/authz.test.sql`
(each block replays the attack), `handle_recovery.test.sql` (W4) and the vitest files named below. Key and
identity findings (K1, K2, W2, C1, L9, L11, L12, I6, I7) are tracked separately.

| ID | Status | What changed |
|---|---|---|
| D1 | Fixed | The publication no longer publishes DELETE (`pubdelete = false`); `pokes` leaves it; unfriend/unlike reach the people involved as content-free broadcasts on the private `db:<uid>` topic (owner-only RLS on `realtime.messages`). Production: enable "Private channels only" (07-launch.md §1). |
| D2 | Fixed | `kw.private_members_guard` + `public.create_conversation()`: chat members only by connection, or shared circle when `requests_from` allows; calls, ringing, inbox signals and notifications inherit it. `recovery_request` notifications are server-only; `recovery_trustee` needs a real share. UI: "You can only start a chat with your connections…". |
| D3 | Fixed (residual) | Profiles readable by self, staff, connections (any request state), friends of friends, audience peers, notification actors, trusted friends, discoverable profiles; others via exact-handle `find_profile()` only. Residual: connections still see `status`/`created_at` (column privileges would break `select *` in `lib/keys/session.ts`). |
| D4 | Fixed | Every report kind is validated against what the reporter can see; `target_owner_id` and `stored_envelope` are server-derived; workflow columns can't be pre-filled. |
| W1 | Fixed | `lib/auth/next.ts` (`safeNext`/`safePath`): control characters and backslashes refused, resolved against a fixed origin; also used for notification taps (`PushManager`). Test: `next.test.ts`. |
| W3 | Fixed (residual) | Lookup answers from the profile id for every existing handle (no account-type branch, one query either way); unknown handles get a v4-UUID-shaped HMAC decoy; fails closed without a secret; DB-backed limit. Residual: no per-handle limit on the GoTrue password grant itself. Test: `passphrase-decoy.test.ts`, `passkey.e2e.test.ts`. |
| W4 | Fixed | ALTCHA proof-of-work on both start routes; per-requester (daily IP tag) and open-request limits instead of a per-account cap; friends are prompted (and can see the request) only after the waiting period, once per 12 h; reworded prompt. Residual: `trusted` count/threshold still returned before acceptance. |
| N1 | Fixed (not compiled here) | iOS `MainFrameBridgeGate` replaces Capacitor's `bridge` handler: main frame of the app origin (or the bundled offline page) only. Needs an Xcode build to confirm. |
| N2 | Fixed | CI no longer passes the bypass secret; `capacitor.config.ts` refuses it when `CI` is set; shorter artifact retention for non-tag builds. Delete the `VERCEL_AUTOMATION_BYPASS_SECRET` GitHub secret. |
| C2 | Fixed | Chat link previews only on an explicit "Add link preview" tap (setting: Privacy → Offer link previews in chats); privacy policy §4.8 updated (both copies). Test: `chatModel.test.ts` + browser run. |
| P1 | Fixed / reworded | Blocked people lose the 1:1 history (`kw.dm_hidden_from`); group-chat caveat added to the block copy; native wipe now clears WebView data (`KithwallShell.clearWebData`); "never store IP addresses" → "keyed hash, rotated daily"; brief/README profile claim narrowed. C1 and K2 claims: keys stream. |
| L1 | Fixed | No self-adds to someone else's chat or list. |
| L2 | Fixed | Ban lifts and actions against staff are admin-only; report targets immutable (except FK set-null on account deletion). |
| L3 | Fixed | Invites can't be reset or extended (≤ 30 days); `redeem_invite` checks active accounts and blocks. |
| L4 | Fixed | Upload rate (3000/day) and 10 GiB per account; orphaned uploads removed by the ephemeral cron. |
| L5 | Fixed | See P1. |
| L6 | Fixed (partly) | `clientIp` counts `TRUSTED_PROXY_HOPS` from the right (Vercel: `x-real-ip`); lookup and recovery limits are in the database. The handle-availability route still uses memory. |
| L7 | Fixed | `request_account_deletion` requires aal2 when enrolled. |
| L8 | Fixed | No site URL in production → no mail; `siteOrigin` never falls back to the Host header there. |
| L10 | Fixed | Hidden chats never write `kw.eph.suggest.*`, `kw.read.*` or the voice-played list; hiding a chat removes old markers. |
| L13 | Fixed (partly) | Actions pinned to SHAs, `persist-credentials: false`, Supabase CLI pinned. Not done: protected signing environment (GitHub settings), `npm ci --ignore-scripts`. |
| L14 | Fixed | Tag builds fail without the upload key; local release builds need `KITHWALL_ALLOW_DEBUG_SIGNING=true`; wrapper checksum + `wrapper-validation`. |
| L15 | Fixed | Notification intents carry a per-install token; `kw_url`/`kw_tag` from other apps are ignored; WebView data cleared on wipe. |
| I1, I3 | Fixed | TRUNCATE/TRIGGER/REFERENCES revoked; `kw.rate_limit` serialised per user and action. |

## 10. Re-review (HEAD `760720d`, 2026-10-21)

**Method**

- Re-ran the original attacker probes (as `authenticated` with forged JWT claims, every probe in
  `BEGIN … ROLLBACK`) against the local Supabase with all eight `20261028*` migrations applied. The applied
  function bodies were checked against the committed files.
- `supabase/tests/authz.test.sql` passes (1..68, all ok). `authority.test.ts` and `pins.test.ts` pass
  16/16. `packages/crypto` passes 143/143.
- Live route probes on a local dev server (port 3081), then cleaned up. One `altcha_spent` row and a few
  `anon_rate_events` rows from the proof-of-work replay test remain in the **local** DB only.
- Full git-history secret re-scan, including the GitHub `refs/pull/*` refs.
- Probe scripts and outputs:
  `[local scratch folder]`.

### 10.1 Verdicts on the original findings

| ID | Verdict | Evidence |
|---|---|---|
| K1 | **Partly fixed** | Malicious member is closed. Probes: a member planting a future epoch, planting the current epoch before its record, inserting into `audience_epochs`, calling the record/advance RPCs, bumping `current_epoch`, self-promoting to admin, re-signing the owner's record, deleting the owner's deliveries: all refused. `authority.ts:71-76` adopts only keys matching a signed epoch record; `ensureOwn`/`storeFor` no longer adopt or silently keep planted keys (`keyring.ts:256-288`). The operator variant remains: see R-K-1 and R-K-2. |
| K2 | **Fixed** (stolen-session threat) | Every direct path is refused with "identity keys can only change through a key change signed by the old key": aal1, aal2, `key_version` only, upsert, even `service_role`. `apply_identity_key_change` is not executable by `authenticated`. The route `/api/account/identity-key` requires aal2 when enrolled, a single-use `rotate_identity` proof of key, a ±10 min timestamp, and a signature by the current key over `{userId, newSignPub, newKxPub, at}`. The row is locked and `oldSignPub` must equal the current key, so there is no replay or race. TOFU pins live in the vault; sealing to an unvouched change stops. |
| W2 | **Fixed** | Passkey add requires an identity-key signature bound to the WebAuthn challenge (`credentials-server.ts:11-19`), and passphrase enable requires an `add_credential` proof of key. Both send a server-only `security_notice` plus an email. The proof does not stop XSS, which runs inside the unlocked page; that is inherent. |
| D1 | **Fixed** (plus production config) | `pubdelete = f` on the publication and `pokes` removed. The remaining tables publish INSERT/UPDATE only, under RLS, with the default replica identity. The `db:<uid>` topic has SELECT-only owner RLS with a strict lowercase-UUID parse. A could not read `db:B`, and could not send on `db:B`, `db:A`, `inbox:B` or `ring:B`. The payload is just the table name. **Production must enable "Private channels only"** (`private_only` is still `f` locally). |
| D2 | **Fixed** | A stranger adding B (`requests_from='nobody'`) is refused with `not_connected`: by direct insert, by `create_conversation`, and by adding B to an existing chat. Member identity is immutable, and group/event adds are friends-only. `may_signal(B)` and `shares_conversation(A,B)` return false. `recovery_request`/`recovery_trustee` notifications from clients are refused. After a block, ring and signal rights are lost. |
| D3 | **Fixed** (documented residual) | A fresh stranger sees 0 of 49 profiles. `find_profile` matches the exact handle only, returns nothing for blocked users, and allows 300 calls per hour. Residual: connections still see `status`/`created_at`. |
| D4 | **Fixed** | A forged group report is refused ("cannot report what you cannot see"). On a profile report, `target_owner_id` is server-derived and a forged `stored_envelope` is nulled. |
| W1 | **Fixed** | `lib/auth/next.ts` was fuzzed with node: tab, newline, backslash, `//`, `/.//`, `/..//`, `javascript:`, U+2028, `%5C`, `%2F%2F` and `/@evil` are all refused or stay on the site. It is used by SignIn and PushManager. |
| W3 | **Partly fixed** | The lookup no longer branches on account type, decoys are UUIDv4-shaped, it fails closed without a key, and the limit is DB-backed. Residual R-W3 below. |
| W4 | **Partly fixed** | Proof-of-work is required on both start routes (live: missing, forged and replayed solutions get 400). Cancelled requests no longer count. Trustees are prompted only after the waiting period, at most once per 12 h, with reworded copy. Residual R-W4 below. |
| N1 | **Fixed in code; needs an Xcode build** | `MainFrameBridgeGate` replaces Capacitor's `bridge` handler in `capacitorDidLoad()`, before any load, and Capacitor never re-adds it. It requires `isMainFrame` plus scheme and host matching `serverURL`/`localURL`. Residual I-N1 below. |
| N2, L13, L14 | **Fixed** | Bypass secret removed from CI, and `capacitor.config.ts` refuses it under `CI`. All 7 action SHAs match their tags on GitHub. `persist-credentials: false`. CLI pinned. Tag builds need the keystore. Wrapper checksum and validation added. Not done (acknowledged): a protected signing environment and `--ignore-scripts`. **Delete the `VERCEL_AUTOMATION_BYPASS_SECRET` GitHub secret.** |
| C2 | **Fixed** | Chat previews are fetched only on the "Add link preview" tap. |
| P1, L5 | **Fixed** | A blocked user sees 0 messages of the 1:1 chat, and media follows. The native wipe clears WebView data on both platforms. Claims reworded. |
| L1, L3, L7 | **Fixed** (probed) | Self-add refused. Invites can only be shortened. Deletion request at aal1 with TOTP refused. |
| L4, L8, L10, L15 | **Fixed** (code) | L15: notification intents carry a per-install 32-byte token, compared in constant time. |
| L6 | **Partly fixed** | `x-real-ip` on Vercel, `TRUSTED_PROXY_HOPS` elsewhere. A self-hosted server with no proxy still trusts a client-sent XFF (document this). The handle-availability limit is still in memory. |

### 10.2 New and residual findings

**R-K-1. High (residual of K1/K2; operator or DB-compromise threat): incoming keys, epoch records and
content signatures are verified against the server-published `sign_pub`, not the pinned one.**

- **Evidence**: pins are consulted only by `sealGate` and the banner (`pins.ts:80-100`; callers
  `keyring.ts:305` and `KeyChangeBanner`). Sealer and rotator keys come from `people.get(...).sign_pub` and
  `freshSignPubs` (`keyring.ts:168-205`). Content signatures are checked against `prof.sign_pub`
  (`people.ts`).
- **Exploit**: an attacker with superuser access disables `profiles_guard` and swaps a group admin's or
  conversation owner's `sign_pub`. They advance the epoch and insert an `audience_epochs` row signed by the
  swapped key. `recordIsValid` passes, every member **adopts** the operator's epoch key and encrypts the
  circle or chat to it, and no conflict is raised. Forged posts in that person's name also verify. The only
  signal is a "safety number changed" banner on that person's profile or 1:1 chat.
- **Why it matters**: spec §3.6 says the server can't inject a key. That is true for planting, but not for
  this path.
- **Fix**: in `ingest`/`judgeKey`, `recordIsValid` and content verification, resolve the signer through
  the pin (or a `vouchedFrom` chain from it). Treat an unvouched key as unverified: do not adopt its
  records or keys, and show the content as unverified.

**R-K-2. Medium (operator): "ghost admin".**

- The roster and `owner_id` used by `isKeyAuthority` are server data, with no signed membership log
  (`keyring.ts:131-153`).
- An operator can insert a puppet as an active admin, rotate, and members adopt the puppet's key.
- **Fix**: owner-signed roster or admin entries. At minimum, show a prominent in-chat notice whenever a
  member or admin is added, and document the limit.

**R-W3. Medium: GoTrue timing still reveals passphrase accounts.**

- Live on the local stack: a wrong password against a real passphrase account's synthetic address took
  0.11–0.33 s (bcrypt runs); a decoy address took 0.010–0.016 s.
- Passkey-only accounts have no password and are inferred to answer fast (none exist locally to measure).
- **Exploit**: list the passphrase-only accounts, then guess passwords against them; GoTrue limits per IP
  only.
- **Fix**: proxy the password grant through a server route that runs a constant-cost dummy hash and
  rate-limits per handle.

**R-W4. Medium: trusted-friend recovery can still be locked.**

- `start_handle_recovery` refuses new requests once an account has 10 open ones
  (`20261028010500_authz_recovery.sql:114-116`). Each requester may file 2 per account per day, and the
  requester tag is an HMAC of the **full** IP address (`passkey-server.ts:111-114`).
- Five IPv4 addresses, or one IPv6 /64, keep the account at the cap indefinitely (requests last 72 h)
  for about 25 CPU-seconds of proof-of-work. An owner who has lost every device can never start recovery,
  and friends are prompted for the attacker's oldest request.
- The recovery-key path (200 per hour per account) can be exhausted the same way at a higher cost.
- **Fix**:
  - tag IPv6 clients by /64;
  - at the cap, let a new request replace the oldest one that hasn't notified friends yet, instead of
    refusing;
  - don't count the owner's own successful proof-of-key against per-account limits.

**N-A1. Low: a pending join request to a closed group grants profile visibility and notification-insert
rights toward its owner, bypassing `requests_from='nobody'`.**

- Cause: `kw.audience_peers` (`20261028010300_authz_profiles.sql:33`), plus `kw.shares_audience`
  accepting members of any status.
- Probe: A sent B a `comment` notification with a random object id, which fires a push. It needs the
  group's UUID; ringing stayed refused.
- **Fix**: require `status='active'` for these paths.

**N-A2. Low: circle co-members can insert notifications of any type with made-up object ids to members who
set `requests_from='nobody'`.**

- This is spam or phishing via push.
- **Fix**: derive notifications server-side from the triggering row, or validate that `object_id` exists
  and was caused by the actor.

**R-K-3. Low: a malicious member can starve another member of the current key.**

- The member relays garbage for the current recorded epoch before the owner does, and the recipient
  deletes it as a conflict (`keyring.ts:186-191`).
- The owner's delivery then hits 23505 and is treated as delivered (`:283`), so the member can keep
  winning, and can also rewrite its own delivery later.
- **Fix**: authority deliveries override relays (or include `sealed_by` in the primary key); no content
  UPDATE for non-authorities.

**R-K-4. Low: demoting an admin can strand members.**

- Their record for the current epoch becomes invalid (`authority.ts:52`), and the owner's redelivery is
  skipped.
- **Fix**: rotate on demotion, or let the owner overwrite.

**R-K-5. Low (pre-existing): a session-only attacker can overwrite `key_bundles`.**

- The "owner updates bundle" policy needs no proof of key, so the attacker can destroy the victim's
  wrapped keys (lockout). They cannot change the published keys.
- **Fix**: write bundles through a proof-of-key route, or keep previous versions.

**Info**

- **I-N1**: Capacitor iOS synchronous `prompt()` bridge calls (`CapacitorCookies`, `CapacitorHttp`;
  `WebViewDelegationHandler.swift:271-301`) are not gated by `MainFrameBridgeGate`. Embeds are safe today
  only because their sandbox lacks `allow-modals` (`Media.tsx:206`). Gate
  `runJavaScriptTextInputPanel` the same way, and never add `allow-modals` to embeds.
- **Lookups that still reveal handles and UUIDs**:
  - the anonymous passphrase lookup and `/api/recovery/account` return a user's UUID for any existing
    handle (one proof-of-work per call for the latter);
  - `find_profile` allows 300 lookups an hour per account.
  - These are handle-existence oracles; acceptable, but note them in the threat model.
- `requests_from` defaults to `everyone`. Given "safe by default" and the at-risk audience, consider
  `mutual`.
- On a misconfigured deployment (no site URL), `friends/start` returns 503 after creating the request row.

### 10.3 Secrets re-scan (full history, 32 commits on all local refs, plus GitHub PR refs)

- **No secrets.** The new commits `a40ba07` and `760720d` were scanned with the same patterns as §7 plus
  `whsec_`, `rk_live_`, GitHub `ghs_`/`ghu_`/`ghr_`.
- The only additional hit is `v1,whsec_bG9jYWwt…` (base64 of `local-dev-hook-secret-0123456789abcdef`).
  - Where: `supabase/config.toml:284`, `docs/deploy.md`, `docs/v2/07-launch.md`; present since `6408e77`
    (my §7 patterns missed it).
  - It is a documented local-only value. The hook route accepts raw secrets only outside production.
  - **Owner check (needs verification, production not accessed): the production `AUTH_HOOK_SECRET` must be
    a freshly generated secret, not this value.**
- Other hits are placeholders (`postgres://user:pass@` in this report, `a-test-secret-of-sufficient-length`
  in a test, `YYYY…`/`ZZZZ…` fixtures) and the RFC test vectors.

**New finding P-1. Medium (maintainer privacy; blocks the "make repository public" step as planned): the
author rewrite is undone by GitHub pull-request refs.**

- `v2` and `main` now carry only the `443abdul` identity. But GitHub's `refs/pull/1…8/head` (Dependabot
  PRs) still point at the **pre-rewrite** history.
- Every PR's parent chain contains 7 commits authored `[old author] <[personal email]>` (`0b76782` …
  `fc8ffa1`, checked by fetching the refs into a scratch repo).
- Those refs cannot be deleted with git, so they become public, along with the old code, when the repo is
  made public. The local `backup/pre-author-rewrite` branch has the same history; do not push it.
- **Fix**: do not flip this repository to public. Either publish to a **new** repository containing only
  the rewritten branches and tags, or close the PRs and ask GitHub Support to remove the
  `refs/pull/*` refs and run garbage collection before making it public.
- The secret scan of that old history was clean (§7).

### 10.4 Launch verdict: **NO-GO** (one remaining blocker; close to GO)

The Critical and three original High findings are fixed against users and stolen sessions, and confirmed
by probes. What remains:

**Blocker**

1. **R-K-1 (High)**: verify keys, epoch records and content signatures against the pinned or vouched
   identity key, not the server-published one.
   - Without it, the operator (or someone who breaches the DB) can make a whole circle adopt a key they
     hold, with only a per-contact safety-number banner as warning. That contradicts the published "the
     server can't inject a key" claim.
   - The change is narrow (`keyring.ts` `ingest`/`judgeKey`, `authority.ts` `recordIsValid`, and
     `people.ts` verification). The alternative is for the owner to explicitly accept the risk **and**
     narrow the claim in `docs/03-spec.md` §3.6, the brief and the transparency copy to "only with a
     visible safety-number change".

**Launch-day gates (configuration and process, not code)**

- Enable Realtime "Private channels only" in production (D1).
- Delete the `VERCEL_AUTOMATION_BYPASS_SECRET` GitHub secret (N2).
- Confirm the production `AUTH_HOOK_SECRET` is not the local dev value.
- Compile and smoke-test the iOS build to confirm `MainFrameBridgeGate` (N1).
- Before making the code public: resolve P-1 (publish to a fresh repository, or have GitHub purge the PR
  refs).

**Strongly recommended before or just after launch**

- R-W4: recovery lockout. Tag IPv6 clients by /64 and let new requests supersede old ones at the cap.
  This is a small change, and the risk is a targeted denial of recovery to at-risk users.
- R-W3: route the password grant through the server with a constant-cost hash and a per-handle limit.
- R-K-2: show a notice when someone is added as a member or admin.

**After launch**: N-A1, N-A2, R-K-3, R-K-4, R-K-5, I-N1 and the Info items.

Once R-K-1 is fixed (or formally risk-accepted with the claims narrowed) and the launch-day gates are
done, the verdict is **GO**.

## 11. Remediation status: re-review findings (second fix pass, 2026-10-21)

Migrations `20261029000100_keys_roster_signed.sql`, `…000200_authz_recovery_signin.sql` and
`…000300_authz_notifications.sql`. Database regression tests in `supabase/tests/rereview.test.sql` (53 checks;
each block replays a re-review probe) plus the updated `handle_recovery.test.sql` and `keys.test.sql`. The
original probe scripts (`…/secreview/rereview/`) were re-run against the fixed database and now fail where they
used to succeed (K1.9 relay rewrite: 0 rows; N-A1 owner profile: 0 rows and the notification is refused; N-A2:
refused).

| ID | Status | What changed | Tests |
|---|---|---|---|
| R-K-1 | **Fixed** (TOFU residual) | `people.get(id)` carries the identity keys this device TRUSTS, resolved through the pins (`lib/keys/pins.ts` `resolveSigners`, `pinsCore.trustedKeysFor`): the pinned key, or a newer one that a chain of signed key changes from the pin vouches for. My own keys come from my unlocked identity. A published key that nothing vouches for is ignored. The keyring opens seals and checks epoch records with the pinned key (`authority.judgeIncoming`), so the operator's key is not adopted. The delivery waits (it is retried once the user accepts the change), and the circle or chat shows "Kithwall didn't use a key from …" with a link to the safety number. Every other signature check that goes through `people` uses the trusted key too: posts, comments, messages, profile info, notifications, call signalling, recovery shares and friend notes. Sealing (notifications, recovery shares) uses the pinned kx key. The safety-number banner adds "anything signed with the new key shows as unverified". People are pinned on first sight whenever they are loaded. If the pins can't be read, people stay "loading" (fail closed). | `lib/keys/pinned.test.ts` (attack replay with real crypto, including the "published key" control). `lib/keys/keyswap.e2e.test.ts`: a superuser disables `profiles_guard`, swaps an admin's keys, advances the epoch with a record signed by the swapped key and seals that key to a member; the member, reading through RLS with its pins, does NOT adopt it and raises the identity warning, while trusting the published key would have adopted it. Browser run: the owner sees the warning in the circle and "safety number changed" on the admin's profile. |
| R-K-2 | **Fixed** (operator residuals below) | Admin promotions carry a signed grant (`audience_members.grant_by` / `grant_sig`, `signAdminGrant` over audience, member and granter). The database requires the granter to be the caller and a key authority, and `kw.is_key_authority` ignores admins without a grant. Clients count an admin as a key authority only with a grant chain back to the owner, verified against pinned keys (`authority.verifiedAdmins`). Unsigned admins show as "Admin (unconfirmed)", with a "Confirm admin" action. Content-free server notices for every join, promotion and change of owner: notice messages in group chats, `audience_roster_notices` for circles and events; shown in the chat timeline (promotions highlighted) and on the circle page. Each device remembers each circle's and chat's key authorities in its vault (`rosterpins`) and shows a prominent "New admin: …" warning for anyone new (not for admins it promoted itself). | `rereview.test.sql` R-K-2 block; `pinned.test.ts` grant chains; browser run. |
| R-W4 | **Fixed** | Requester tags are per IPv4 address or IPv6 /64 (`lib/auth/ip-bucket.ts`). One open request per requester per account (a new one supersedes it). At the cap of 10 open requests a new request supersedes the oldest instead of being refused. The account-wide limit on recovery-key lookups is gone (per-client 12/h plus proof-of-work remain). Other people's requests can no longer get the owner refused. | `handle_recovery.test.sql` (the cap no longer refuses; one open request per requester); `ip-bucket.test.ts`; `recovery.e2e.test.ts` "R-W4" (three addresses in one /64 count as one requester, so the third is refused; with 10 IPv4 requesters at the cap, the owner's request is still accepted). |
| R-W3 | **Fixed** | `POST /api/auth/passkey/passphrase/signin {email, authKey}`: `public.passphrase_password_ok()` runs exactly one bcrypt (cost 10) for every input. Limits per client (30 / 10 min), per handle per client (10 / 15 min) and per handle (100 / h), then a one-time session token. The browser no longer calls GoTrue's password grant for handle sign-in or passphrase sign-up. Passkey-only accounts get a random, never-used GoTrue password (new accounts in `createAuthUser`, existing ones in the migration), so a direct GoTrue grant costs one bcrypt for every synthetic account too. **Timing** (local, wrong passphrase, median, min–max): before, GoTrue grant: passphrase account 112 ms (108–179), unknown handle 15 ms (7–22). After, the route: passphrase account 209 ms (176–329), passkey-only 208 ms (163–362), passkey-only with random password 210 ms (182–353), unknown handle 202 ms (165–374); n = 15 each. The e2e test measured 232 vs 214 ms (ratio 1.08). | `rereview.test.sql` R-W3 block; `passphrase-signin.e2e.test.ts`; browser run (sign-in calls only `/passphrase/signin`). |
| N-A1 | **Fixed** | `kw.audience_peers` and `kw.shares_audience`: a pending join request gives nothing. An invitation still shows the owner and the inviter, and lets them notify the invitee. | `rereview.test.sql` N-A1 block |
| N-A2 | **Fixed** | Restrictive policy "notifications describe something real" (`kw.notification_ok`): clients may insert only the types the app sends (friend request/accept, group/event invite, tag, comment, like, recovery_trustee), each tied to a real object the actor caused: their comment or like on that post or photo, their tag, the invitation, the friendship or the share. Everything else is server-made. | `rereview.test.sql` N-A2 block; the push, rls and native_push tests now use real notifications. |
| R-K-3 | **Fixed** | A delivery by a key authority replaces a relay for the same recipient and epoch (trigger). Relays don't count as delivered for the authority (`kw.key_delivered`), and only authorities may rewrite their deliveries. | `rereview.test.sql` R-K-3 block; `keys.test.sql` |
| R-K-4 | **Fixed** | Demoting an admin rotates the key (`groups.setRole`). An admin's device also rotates whenever the current epoch's record no longer counts on it (`keyring.currentRecordStale`, run by circle housekeeping): its rotator was demoted or left, or it was signed with an untrusted key. | Browser run: demote → epoch + 1, and the remaining member still reads the circle. |
| R-K-5 | **Fixed** | The "owner updates bundle" policy is gone. `/api/account/bundle` (proof-of-key purpose `update_bundle`, aal2 when enrolled, identity part unchanged) is the only client path; password/passphrase changes and new recovery keys use it. | `rereview.test.sql` R-K-5 block; `passkey.e2e` and `recovery.e2e` |
| I-N1 | **Fixed in code; needs an Xcode build** | `MainFramePromptGate` wraps Capacitor's `WKUIDelegate`. `window.prompt()` (the synchronous CapacitorCookies / CapacitorHttp bridge) is answered with nil unless it comes from the main frame of the app's origin; every other UI-delegate call is forwarded. The origin check (`AppOrigins`) is shared with `MainFrameBridgeGate`. | Not compiled here. |

**Residuals and notes**

- Trust on first use: a device that has never seen someone pins whatever the server publishes at that
  moment. Pins live in the encrypted vault, so an operator who deletes the `keypins` namespace (or rolls the
  vault back) makes the device pin again on next sight. Comparing safety numbers is the defence for high-risk
  contacts.
- The roster is still server data. An operator can replay an old grant (re-promote a former admin) or hand a
  group chat to a puppet owner. Members get the server notice (unless the operator suppresses it) and,
  independently, their device's own "New admin" warning, but keys from that authority are adopted meanwhile.
  Admins promoted by someone who has since lost their admin role stop counting until the owner confirms them.
- Existing admins have no grant. After this migration they are not key authorities until the owner taps
  "Confirm admin" (Members tab). Owners keep full control.
- A direct GoTrue password grant still answers fast for addresses without an auth user (unknown handles, and
  v1 email accounts, whose handle maps to a synthetic address that doesn't exist). It can therefore tell a
  Kithwall 2 account from "no account, or a v1 email account". It no longer tells passphrase accounts from
  passkey accounts.
- The passphrase route's per-handle limit can be used to slow one person's passphrase sign-in for up to an hour
  (100 attempts an hour overall). Passkeys and the recovery paths are unaffected.
- `requests_from` still defaults to `everyone` (unchanged, as decided).

## 12. Final verdict (HEAD `2238e16`, 2026-10-22)

**Method**

- Re-ran the §10 probes against the local DB with migrations `20261029000100…300` applied. The applied
  bodies were checked against the committed files.
- Every probe ran as `authenticated`/`postgres` inside `BEGIN … ROLLBACK`; 0 leftover rows.
- Tests:
  - `pinned`, `pins` and `authority`: 26/26.
  - `keyswap.e2e` (superuser swaps an admin's key and posts a signed epoch record): passes; the key is
    **not** adopted.
  - `packages/crypto`: 146/146.
- Live timing on a local dev server (port 3081); the server is stopped and cleaned up.
- Secrets scan of the new commit.
- Probe scripts and outputs:
  `[local scratch folder]`.

### 12.1 Verdicts

| ID | Verdict | Evidence |
|---|---|---|
| R-K-1 | **Fixed, except NEW-1** | Every signature check (content, messages, photos, stories, events, groups, notifications, friend notes, recovery shares, export, chat and call signalling, safety codes, keyring sealer/rotator/grant) now resolves keys through `people.get`, which holds pinned or vouched keys. If the pins are unreadable, people stay "loading" (fails closed). New sealing in `deliverTo` is gated by `sealGate`. |
| R-K-2 | **Fixed** (documented operator residuals) | Probes: a member self-granting is nulled; self-promotion is refused; the owner promoting without a grant, or with a forged `grant_by`, is refused; chained admin grants work; demotion clears the grant; a legacy unsigned admin is not a key authority. The grant does not cover epoch or time, so an operator can replay an old grant (documented; the device's "New admin" warning still fires). |
| R-K-3 | **Fixed** | Probes: a member cannot rewrite its relay (UPDATE 0); `key_delivered` ignores relays; the owner's delivery replaces the relay. |
| R-K-4 | **Fixed** (code) | `setRole` rotates on demotion; `currentRecordStale` re-rotates when a record no longer counts. |
| R-K-5 | **Fixed** | `key_bundles` has no client UPDATE or DELETE. `/api/account/bundle` requires a single-use `update_bundle` proof of key and aal2 when enrolled. It keeps the identity part byte-identical and never drops `amkByPassword`. |
| R-W3 | **Fixed for the route** | `/passphrase/signin` medians, n=12 each: passphrase account 233 ms, other synthetic account 232 ms, unknown address 230 ms, all with the same 401. `passphrase_password_ok` is SECURITY DEFINER with `search_path=''`; `anon`/`authenticated` get permission denied. Residual NEW-4. |
| R-W4 | **Not fixed (regressed in a new way)** | See NEW-2. |
| N-A1 | **Fixed** | A pending join request gives 0 profile rows, and `group_invite` is refused. |
| N-A2 | **Fixed** | Refused: a fake `comment`, a `like` with no like row, a `friend_request` with no friendship, a fake `recovery_trustee`, `post_published`. Real like and comment notifications still work. Info: duplicates for a real object can be re-inserted (spam only). |
| I-N1 | **Fixed in code; needs an Xcode build** | `MainFramePromptGate` is installed after Capacitor sets `uiDelegate` and is retained (`promptGate`). Other delegate calls are forwarded via `responds(to:)`/`forwardingTarget`. `prompt()` gets nil unless it comes from the main frame of the app's origin. |

### 12.2 Remaining findings

**NEW-1. Medium (operator or DB compromise): identity rotation re-seals past key deliveries to unpinned
keys.**

- **Evidence**: `keyring.ts` `resealMine` (about lines 408-427) reads `profiles.kx_pub` directly and
  re-seals every `audience_keys` row the user sealed, with no `sealGate` and no pin check.
- **Exploit**: when a victim rotates their identity key (e.g. after losing a device), the operator swaps a
  recipient's `kx_pub`. Every current and historical audience key the victim delivered is then sealed to
  the operator. This bypasses R-K-1 for that moment.
- **Fix** (small): seal to `people.get(id).kx_pub` / pass recipients through `sealGate`; skip and retry
  recipients whose key change is unvouched.

**NEW-2. Medium: an attacker can now cancel the owner's own recovery request (R-W4 not fixed).**

- **Evidence**: at the cap, `start_handle_recovery` evicts the **oldest** open request
  (`order by x.created_at, x.id limit open_n - 9`, `20261029000200_authz_recovery_signin.sql`). It does not
  spare requests whose friends were already notified or are approving.
- **Probe**: the owner files a request; 10 requests from fresh requester tags cancel it.
- **Cost**: tags are one per IPv4 address or IPv6 /64. One free /48 tunnel gives 65,536 tags, so about 10
  proof-of-work solutions per eviction keep a device-less owner's request from ever reaching the 24 h wait,
  and can also cancel a recovery already in progress.
- **Fix** (small): drop the cap and eviction (friend prompts are already limited to once per 12 h).
  Failing that: never evict friend-notified or in-progress requests, evict the newest instead, and bucket
  IPv6 by /48.

**NEW-3. Low (availability at migration): existing admins have no grant.**

- Records and deliveries they made stop counting, so members wait for keys until the owner taps "Confirm
  admin" or rotates.
- **Fix**: prompt owners at first unlock after the update to confirm current admins.

**NEW-4. Low: GoTrue's own password grant is still reachable.**

- **Timing**: passphrase account 114 ms, passkey account 113 ms, nonexistent address 19 ms.
- It tells a Kithwall 2 account from a lookup decoy (a handle-existence check, conceded in §11).
- It skips the route's per-handle limits, leaving GoTrue's per-IP limit, which rotating IPv6 addresses
  defeats. Each guess still costs one Argon2id run, against a zxcvbn-3 minimum.
- **Fix**: give passphrase accounts a random GoTrue password and verify `authKey` only in
  `passphrase_password_ok`, or block `grant_type=password` at the edge.

**NEW-5. Low: identity-key rollback.**

- `pinsCore.vouchedFrom` accepts any prefix of the server-supplied key-change chain and does not check
  `change.userId`.
- **Exploit**: an operator can republish a superseded (possibly compromised) key K1 and omit the K1-to-K2
  row, and contacts still pinned on K0 accept K1.
- **Fix**: bind rows to the user id, require a monotonic `key_version`, and refuse keys older than one
  already seen.

**Info**

- `/api/account/bundle` sends no security notice when the recovery key or passphrase changes; add one.
- `ip-bucket.ts` does not strip `:port` from IPv4 values in `X-Forwarded-For`.
- Recovery status serves trustee keys as published (a fresh device has no pins). Confidentiality still
  rests on the RK commitment check.
- TOFU: deleting or rolling back the vault re-pins on next sight (documented).

### 12.3 Secrets

- Commit `2238e16` (the only commit on `v2` since `760720d`) is clean.
- The only pattern hits are this report's own text: `postgres://user:pass@` and the already-documented
  local `whsec_` value.
- Nothing new since §10.3.
- **P-1 is unchanged**: GitHub still holds 8 `refs/pull/*` refs with the pre-rewrite history (author
  `[personal email]`). The repo is still PRIVATE, and `backup/pre-author-rewrite` exists locally.

### 12.4 Launch verdict: **NO-GO at `2238e16`; GO once NEW-1 and NEW-2 are fixed**

The original Critical, all three Highs and R-K-1 are resolved and probe- or test-confirmed. Two small,
well-scoped Medium issues remain that I would not ship to at-risk users. Both are fixes of a few lines,
with tests, and need no further full re-review.

**Launch blockers**

1. **NEW-1**: `resealMine` must seal to trusted keys (`people.get`/`sealGate`).
2. **NEW-2**: recovery eviction must never cancel the owner's or an in-progress request; preferably drop
   eviction altogether.

**Launch-day gates** (configuration and process; all carried over)

- Enable Realtime "Private channels only" in production.
- Delete the `VERCEL_AUTOMATION_BYPASS_SECRET` GitHub secret.
- Confirm the production `AUTH_HOOK_SECRET` is not the local dev value.
- Build and smoke-test the iOS app (`MainFrameBridgeGate` and `MainFramePromptGate`).
- Tell owners of existing circles to confirm their admins (NEW-3).
- **Before the repository goes public**: resolve P-1 (a fresh repository with only the rewritten refs, or
  a GitHub Support purge of the `refs/pull/*` refs), and never push `backup/pre-author-rewrite`.

**Accepted residual risks** (document in the threat model)

- TOFU: first-sight pinning, and vault rollback forcing re-pinning.
- The roster is server data: an operator can replay an old admin grant or install a puppet owner. The
  device's "New admin" warning and the server notice mitigate this.
- Browsers keep non-extractable keys on disk (C1).
- Handle-existence oracles: `find_profile`, the passphrase lookup, the recovery account lookup, GoTrue
  timing.
- The per-handle passphrase limit can slow one person's passphrase sign-in for up to an hour.
- `requests_from` defaults to `everyone`.
- XSS can sign anything inside the unlocked page.

**After launch**: NEW-3 (the UX prompt), NEW-4, NEW-5 and the Info items.
