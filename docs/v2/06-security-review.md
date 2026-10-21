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
