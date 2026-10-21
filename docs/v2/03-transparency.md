# Kithwall 2: transparency and verification

Status: implemented (phase 3) · 2026-10-21 · see also `00-brief.md` §3 "Prove it" and §4 "Transparency"

Four pieces: a live "What Kithwall knows about you" page, safety numbers with a verified badge and
key-change warnings, a public transparency report, and a complete client-side export plus account delete.

## 1. What Kithwall knows about you (`/you/privacy-report`)

Built from the server's actual rows, not copy. Linked from You and from Settings → Your data.

**Data map** (`supabase/migrations/20261024000900_transparency.sql`):

| Table | Contents |
|---|---|
| `kw.data_map_tables` | one row per table in `public` and `kw`: `category` (account, content, social, messages, activity, housekeeping, legacy, system), `owner_pred` (SQL over row alias `t` and the caller `$1`; null = never about a person), `time_col`, `size_col`, `retention`, `note` |
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
events with my RSVP, messages with reactions and notices, the decrypted vault as settings, and
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
