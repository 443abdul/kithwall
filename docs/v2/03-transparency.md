# Kithwall 2: transparency and verification

Status: implemented (phase 3) · 2026-10-21 · see also `00-brief.md` §3 "Prove it" and §4 "Transparency"

Four pieces: a live "What Kithwall knows about you" page, safety numbers with a verified badge and
key-change warnings, a public transparency report, and a complete client-side export plus account delete.

## 1. What Kithwall knows about you (`/you/privacy-report`)

Built from the server's actual rows, not copy. Linked from You and from Settings → Your data.

**Data map** (`supabase/migrations/20261024000900_transparency.sql`):

| Table | Contents |
|---|---|
| `kw.data_map_tables` | one row per table in `public` and `kw`: `category` (account, content, social, messages, activity, housekeeping, system; `legacy` was removed with the
classic tables in `20261030000100_drop_classic.sql`), `owner_pred` (SQL over row alias `t` and the caller `$1`; null = never about a person), `time_col`, `size_col`, `retention`, `note` |
| `kw.data_map_columns` | one row per column: `class` = `id` · `time` · `plaintext` · `ciphertext` · `hashed`, plus a note |

`supabase/tests/transparency.test.sql` **fails if any column of any table in `public` or `kw` is not
classified** (and if a classification is stale, or an envelope/sealed column isn't `ciphertext`). Every
future migration that adds a table or column must add rows to both tables, e.g.

```sql
insert into kw.data_map_tables (table_name, category, owner_pred, time_col) values ('public.things', 'content', 't.owner_id = $1', 'created_at');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.things', 'id', 'id', null), ('public.things', 'owner_id', 'id', null),
  ('public.things', 'envelope', 'ciphertext', 'what it says'), ('public.things', 'created_at', 'time', null);
```

`owner_pred` only matches rows the person may know about: blocks count those you made (never who blocked
you), reports those you filed, notifications those you received.

**RPCs**

- `public.transparency_report()` — SECURITY DEFINER, `authenticated` only, caller only (`auth.uid()`).
  Returns `{version, generated_at, account, passkeys, sessions, auth_log, files, tables[]}`: auth timestamps,
  synthetic vs real email (`u…@id.kithwall.invalid` is reported as "no email"), notice email, recovery saved,
  MFA factor count, passkeys (label, created, last used, synced), Supabase Auth sessions (user agent, IP,
  started/refreshed), the count of auth audit-log entries, stored files (count, bytes), and for each mapped
  table the caller's row count, first/last time, total size and its columns grouped by class. No other
  person's id or handle appears in it (tested).
- `public.transparency_data_map()` — the static map without counts (anon + authenticated).

**Client**: `lib/transparency/report.ts` (types, fetch, JSON download), `lib/transparency/datamap.ts`
(plain-language labels for the main tables; a vitest keeps them in step with the SQL map),
`components/transparency/PrivacyReport.tsx`. Tables without a label still show, by name, with their column
classes under "Technical details". "Outside the database" (hosting logs, backups, never collected) is
fixed text, kept in step with the privacy policy.

**Found while building it**: `kw.rate_events` (spam-limit counters) had no foreign key, so its rows
survived account deletion and were never pruned. The migration deletes orphans, adds
`rate_events_user_fk … on delete cascade`, and a pg_cron job (`kithwall-transparency-maintenance`, hourly)
keeps 7 days. Keep that ≥ the longest `kw.rate_limit` window (currently 1 day).

**Added by the security review fixes** (`20261028010500_authz_recovery.sql`, classified in the map):
`kw.anon_rate_events` (`key` hashed: a SHA-256 of the action and the daily-rotating keyed IP tag, never an
address; `at`), the database-backed limits for pages used without an account (passphrase lookup, account
recovery), pruned after 2 days by `kithwall-recovery-notify`; and on `public.recovery_requests`,
`requester_tag` (hashed, the same daily IP tag, for per-requester recovery limits) and `friends_notified_at`
(time). The transparency page now says "a keyed hash that changes daily" instead of "never store IP
addresses" (security review P1).

**Added by the re-review fixes** (`20261029000100_keys_roster_signed.sql`, classified in the map): on
`public.audience_members`, `grant_by` (id: who made the person an admin) and `grant_sig` (plaintext: that
admin's signature on the promotion, security re-review R-K-2); and `public.audience_roster_notices`
(`social`, owner predicate `member_id` or `actor_id`): content-free notices that someone joined, became an
admin or took over a circle or event (`kind`), kept until the circle or event is deleted. Group chats get
the same notices as server notice messages (`public.messages.notice`, already mapped). The client keeps
its own record of each circle's key authorities in the encrypted vault (namespace `rosterpins`), next to the
identity-key pins (`keypins`); the server never sees either.

**Added by follow and public posts** (`20261112000100_follow_public.sql`, `10-follow-public.md` §8, classified
in the map): `public.follows` (`social`, owner predicate `follower_id` or `followee_id`), `public.restrictions`
(`social`, the people you restricted; `owner_id` only, the restricted person's report never shows it),
`profiles.follow_enabled`, four switches on `privacy_prefs`, and on `posts` `comment_policy`,
`public_hidden_at`, `public_reviewed_at`. The notes of `posts.envelope` and `comments.envelope` now say that
content the author made Public is readable and only signed. The export adds who I follow, my followers, the
people I restricted and my switches (`data/connections.json`, `data/profile.json`); hidden words are part of
the vault (`data/settings.json`).

## 2. Safety numbers (`/u/<handle>/verify`)

- `packages/crypto/src/safety.ts`: `safetyNumber` (existing, Signal-style, 5200 × SHA-512, order-independent),
  plus `formatSafetyNumber` (12 × 5 digits), `normalizeSafetyDigits` / `safetyNumbersMatch` (accepts Latin,
  Arabic-Indic, Persian, Devanagari, Bengali and full-width digits, ignores spaces), `safetyQrPayload` /
  `parseSafetyQr` (`kithwall-safety:1:<60 digits>`). A known-answer vector locks the algorithm.
- The screen shows both avatars, the digits, a QR code (`lib/qr.ts`, on device), "Scan their code"
  (`BarcodeDetector` + camera, `camera=(self)` is allowed; hidden where unsupported) and "Compare the digits"
  (paste/type). A scan that matches marks the contact verified; a typed match enables "Mark as verified".
  Before saving, both keys are re-read from the server and the number recomputed.
- **Storage**: only in the person's encrypted vault (`lib/settings.ts` `vaultUpdate`, namespace `verified`):
  `{ [userId]: { k: sign_pub verified, at, via: 'qr'|'digits' } }`. The server never learns who verified whom.
- **Exported for other screens** (`lib/transparency/verified.ts`):
  - `useVerified(userId)` → `{ status: 'loading'|'none'|'verified'|'changed', verifiedAt, entry }`
  - `useKeyChangeWarning(userId)` → `null` or `{ verifiedAt, changedAt, vouched }`
  - `VerifiedBadge({ userId, showChanged?, label? })` (also re-exported from `components/verify/VerifiedBadge.tsx`)
  - `KeyChangeBanner({ userId, name, handle })` in `components/verify/KeyChangeBanner.tsx`
  - `useSafetyNumber`, `markVerified`, `clearVerified`, `useIdentityKey`
  The current key is fetched fresh (`profiles.sign_pub`, 60 s stale time) only for contacts that are verified,
  so unverified contacts cost nothing. `vouched` follows `public.key_changes` signatures from the verified key.
- Placed on the profile screen (badge, "Verify safety number", warning banner). Chat headers: the messages
  work stream places the badge and a link to `/u/<handle>/verify`.

## 3. Transparency report (`/transparency`, public)

Requests received (all zero), a dated statement, what we can and can't hand over, a static data map, the
"outside the database" section and the source code: open source under AGPL-3.0, with links to the repository and
to the exact commit that is running (`lib/source.ts`, commit inlined at build time from `VERCEL_GIT_COMMIT_SHA`). Linked from the public footer and Settings → Your data.

### Owner checklist (TODO)

- [ ] Keep `apps/web/src/lib/transparency/facts.ts` current: update the request counts when any request
      arrives, and **re-date `asOf` at least every 3 months** even if nothing changed (the page promises
      this and invites people to ask if the date goes stale). Only re-date it after actually checking that
      the statement is still true: no request for user data, no order forbidding disclosure, no demand to
      weaken encryption. If any of that stops being true and you may not say so, do not re-date it. Get legal
      advice on the statement's wording for your jurisdiction before launch.
- [ ] Fill `7 days (Supabase Pro plan)` / `1 hour (Vercel Hobby plan runtime logs)` in the privacy policy; the pages say "the short
      period set by our plan" and point there.
- [ ] **Make the GitHub repository public at launch**: the transparency page, footer, Settings → Help & about,
      privacy policy and /donate all say Kithwall is open source and link to it.
- [ ] When an independent audit is done, replace `transparency.page.sourceAudit` with a link to its report.
- [x] Footer tagline, landing, About and this page all say "open source (AGPL-3.0)" (phase 6).

## 4. Export and delete

`lib/export.ts` (Settings → Your data → Download my data) fetches, verifies and decrypts on the device and
builds `kithwall-<handle>-<date>.zip`: `index.html` (readable, no network), `README.txt`, `data/*.json`
(profile — the synthetic sign-in address is never exported as an email — connections and blocks, posts,
notes, comments, reactions (post likes and decrypted chat reactions), albums, photos, stories, circles,
events with my RSVP, messages with reactions and notices, the decrypted vault as settings, `legacy.json` (my
legacy contact and period, my farewell note opened from my own sealed copy, who chose me and any note released
to me; `03-safety.md` §12), and
`what-kithwall-knows.json` = the live report) and `media/` (album photos, photos and videos attached to my
posts, my live stories, images in chats). Files over 25 MB and chunked videos stay out (counted, "save them
from Kithwall"). Progress names each step. Safety check-ins are not exported yet (safety work stream).

Delete is unchanged: proof-of-key (identity key signs a server nonce) → `/api/account/delete` → storage folder,
then the auth user (cascades every row). Verified in a browser for a passkey-only, email-less account: every
row, passkey and rate-limit counter was gone afterwards.

## 5. Verification (2026-10-21)

pgTAP `transparency.test.sql` 39 tests; crypto `safety.test.ts` + vitest `lib/transparency` 10 tests;
browser (Playwright, system Chrome, headless) against the dev server: report + JSON download, equal safety
number on both sides for two accounts, verify by digits → badge, simulated key change (SQL) → warning and
"changed" badge, restored → verified again, `/transparency` at 1280/375 and in Arabic RTL with the Minimal
dark style, export ZIP contents, passkey account delete. Screenshots: `screens/phase3-trans-*.png`.

## 6. Crash reports (opt-in, 2026-11-11)

To keep the app free of bugs the owner needs to hear about crashes, without tracking anyone. Settings → Your
data → **Send crash reports**, **off by default**, per device. No third-party service is involved.

**What is caught** (`lib/crash/client.ts`, loaded only while the setting is on): uncaught errors and unhandled
promise rejections of the page, what React's error boundaries catch (`app/error.tsx`, `app/global-error.tsx`,
which also give people a "Try again" screen), and in the Android app a crash of the app itself, written down
by an `UncaughtExceptionHandler` (`KwCrash.java`: class names and stack frames only, never the exception
message, and only while the setting is on) and sent on the next start. Network failures, aborted requests and
failed chunk loads are not reported.

**What a report contains** (`lib/crash/report.ts`), and nothing else:

| Field | Example | Note |
|---|---|---|
| `id` | random UUID | per report, so a retried upload is stored once; linked to nothing |
| `kind` | `error` · `rejection` · `react` · `native` | where it was caught |
| `app` | `{web: "58a235e0c1d2", version: "2.5.0-foss", build: "412"}` | website commit; app version and build |
| `platform` | `web` · `pwa` · `android` · `ios` | |
| `os`, `browser` | `Android 14`, `WebView 145` | family and **major** version only, never the user-agent string |
| `route` | `/messages/[id]` | the route **pattern** (`lib/crash/routes.ts`), never the path or query |
| `locale` | `ur` | interface language |
| `name`, `message`, `stack`, `componentStack` | `TypeError`, … | scrubbed, see below |

No account id, no session, no cookie (the request is sent with `credentials: 'omit'` and no `Authorization`
header or referrer), no device identifier, no time from the device, no content.

**The scrubber** (`lib/crash/scrub.ts`, the privacy boundary, run on the device and again on the server):
foreign addresses are replaced whole; the app's own pages become their route pattern; query strings and
fragments go everywhere; UUIDs, long hex strings, tokens (JWTs, base64url blobs), @handles, e-mail and IP
addresses, file paths, numbers of four or more digits and phone-like strings are replaced; every run of
non-ASCII text is replaced (the app's own messages are English); the message is cut at the first quoted text
unless a browser engine is quoting a code name (`(reading 'envelope')`); only real stack frames are kept (the
stack's header line repeats the message). Caps: message 300 characters, 30 frames, 4,000 characters of stack,
12 kB per report. Residual limit, stated in the code: an unquoted ASCII word inside an error message can't be
told from the message itself; the app's own errors don't put user content there. **"See what gets sent"**
shows the last report exactly as transmitted, or, before there is one, the report the device would send for a
made-up error.

**Server** (`app/api/crash/route.ts`, migration `20261112000400_crash_reports.sql`):

- Size is limited before and while reading (12 kB); the shape is parsed strictly, unknown fields are dropped,
  and the text is scrubbed again, so a modified client can't make the server keep more.
- Rate limit: 12 reports an hour per client, counted under the same keyed, daily-rotating IP tag as the other
  account-less routes (`kw.anon_rate_events`); the address itself is never written to the database or a log
  line. The table takes at most 2,000 reports a day in total. Honest footnote: like every request, the POST
  is in the host's request log (IP and time, 1 hour) without its content.
- `public.crash_reports`: no account, session, device or address column, no foreign key; `received_at` is kept
  to the hour. Written only through `crash_report_add()` (service role); readable only by **admins** (RLS,
  not moderators). `fingerprint` = SHA-256 of the error class and its top six frames without positions and
  build hashes, to group reports of the same bug.
- Deleted after **30 days** by `prune_crash_reports()`, called from the existing daily `/api/cron/ephemeral`
  job (the hosting plan allows few cron routes; no new one was added).
- `/mod` → Admin → **Crash reports**: one row per fingerprint with the count, first and last hour seen, the
  builds and platforms, and the newest report as a sample.

**Data map.** `public.crash_reports` is in the map as `system` with no owner predicate ("never about a
person") and retention "30 days"; every column is classified (`fingerprint` hashed, `received_at` time, the
rest plaintext). It therefore doesn't appear in a person's live report; "What Kithwall knows about you" has a
fixed entry under "Outside the database" that says what a report holds and links to the setting, and another
for the on-device search index (`03-safety.md` §14), which never reaches the server at all. The export README
says why neither is in the export. The privacy policy has the same (§4.4, §4.5, §7.1, §10).

**Tests.** `lib/crash/scrub.test.ts` (26: addresses, identifiers, numbers, scripts, quoted text incl. nested
and unterminated quotes, file paths, forged `<app>` marks, V8 / Firefox / Safari / Java frames, caps, a list of
secrets that must never come out of any sample, idempotence, hostile input and linear running time), `lib/crash/crash.test.ts` (14:
route patterns incl. a check that every page under `src/app` has its pattern, user-agent reduction, the exact
field set, the server's strict parsing and re-scrubbing, fingerprints, noise), `supabase/tests/crash_reports.test.sql`
(40: no column or key that could name a person, server-only writes, retried upload stored once, refused
malformed values, the daily cap, admin-only reading and grouping, 30-day prune).
