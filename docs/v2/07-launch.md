# Kithwall 2: launch (cutover from v1)

Status: prepared, not executed (phase 6) · 2026-10-21 · see also `02-cleanup.md` §4 (v1 tables), `01-accounts.md`,
`05-native.md` §2 (rpID), `../deploy.md`

This is the runbook for replacing the 2010-style app (branch `main`, https://www.kithwall.com, Vercel project
`kithwall-web`, Supabase `uvuojqziktbwxkjzeiar`) with Kithwall 2 (branch `v2`, staging.kithwall.com, Supabase
`yuipqwgolcuddngejblg`). The coordinator executes it with the owner's approval, step by step. Nothing here was
run against production or staging.

**Short version:** the database change is one `supabase db push` of 11 migrations, all of them rehearsed on
v1-shaped data with every pgTAP suite passing. They are additive (§7 lists the few things that are not). Order:
notice → freeze → backup → history rewrite → `db push` → env → merge `v2` → `main` (deploys) → smoke tests → public repo.
Rollback = Vercel instant rollback; the database stays on v2.

---

## 1. What changes in production

| | |
|---|---|
| Migrations | `20261021000100_passkeys` … `20261026000100_native_push` (10, already on staging) **plus** `20261027000100_classic_export` (new in phase 6, **not yet on staging**: two caller-only read functions for the Classic export, no tables or columns). Production is at `20261020000100_push`. |
| pg_cron | Adds `kithwall-passkey-maintenance` (hourly), `kithwall-story-maintenance` (10 min), `kithwall-ephemeral` (every minute), `kithwall-safety-checkins` (every minute), `kithwall-transparency-maintenance` (hourly), `kithwall-recovery-notify` (10 min: tells trusted friends about a recovery request once its waiting period is over, security review W4). `kithwall-auth-maintenance` exists already. |
| Storage | No new bucket. Everything still goes to the private `media` bucket (30 MiB per object; videos are split). |
| Realtime | `message_reactions` and `posts` join the `supabase_realtime` publication. Security review D1 (`20261028010100_authz_realtime`): the publication **stops publishing DELETE events** (Realtime can't apply RLS to them) and `pokes` leaves it; deletes a client cares about arrive as content-free broadcasts on the private `db:<user id>` topic. **Also turn on Realtime → Settings → "Private channels only" in production** (every Kithwall channel is already private). |
| Web | `main` becomes the v2 app. `vercel.json` crons are unchanged and all daily (§6). |

## 2. Migration safety (done in phase 6)

### 2.1 Rehearsal on v1-shaped data

`supabase/launch/rehearse.sh` builds a throwaway database `kw_launch_test` inside the local Supabase Postgres
container. The main local database is not touched. It then:

1. Copies the auth, storage and realtime schemas from the local stack, plus Supabase's default grants.
2. Replays the v1 migrations exactly as production has them.
3. Loads `supabase/launch/seed_v1_sample.sql`: 10 v1 accounts, covering email + password key bundles with
   `amkByPassword`, TOTP MFA, an unconfirmed email, a confirmed account without keys, a suspended account, a
   banned account and a scheduled deletion. The seed also has every kind of v1 content:
   - friendships (accepted and pending), a block, friend lists;
   - Wall posts by friends, and posts of every kind (`status`, `photo`, `link`, `video`, `question`, `checkin`,
     `life_event`, `game`, `note`, `share`);
   - open, closed and secret groups; public and private events; Pages with likes; poll votes;
   - albums, photos, tag approvals and media rows;
   - a DM and a group chat, with an epoch rotation and v1 read markers (one of them in the future);
   - every v1 notification type, pokes, Kithville state and gifts;
   - invites, recovery shares, requests and responses, reports, moderation actions;
   - push subscriptions and preferences, and orphaned rate-limit rows.
4. Applies the v2 migrations the way `db push` does: each file in one transaction, as `postgres`.
5. Runs `supabase/launch/verify_cutover.sql` (88 assertions).
6. Runs **every** `supabase/tests/*.sql` against the migrated database, then drops it.

Result (2026-10-21): every migration applied with no error, `verify_cutover.sql` 88/88, and all 19 suites passed
on the migrated v1 database (classic_export 12, auth 49, calls 46, circles 33, community 85, ephemeral 87,
handle_recovery 20, integration 5, messages 38, messages_v2 40, native_push 34, passkeys 62, photos 37, push 42,
rls 57, safety_checkins 41, social 33, stories 38, transparency 39).

`verify_cutover.sql` proves:

- **Nothing was lost.** Every v1 table has the same row count, there are no `NOT VALID` constraints, and all six
  cron jobs exist.
- **v1 accounts still sign in.** All bundles keep `amkByPassword` and pass the v2 validator
  `kw.check_key_bundle`. `kw.has_fallback_unlock` is true for them, so adding or removing passkeys works. Public
  keys still match the profiles. A TOTP account still cannot read its bundle or posts at aal1, and can at aal2.
- **The right people can read v1 content through the v2 policies and RPCs, and nobody else can.**
  - Ann reads exactly the 22 posts she should, including a friend's post on her Wall, through `feed_posts`.
    She also reads comments, likes, albums, photos, groups, events, both chats (both key epochs),
    `conversation_previews`, her sealed keys, her notifications (including the old types), her files and her
    `transparency_report`.
  - Ben can't read the only-me note, the closed group he isn't in, or the Family-list album.
  - Cat, who blocked Dan, can't read Dan.
  - Dan, whose request is still pending, can't read Ann's Wall, but can read what Ann wrote on Ben's Wall: the v1
    rule.
  - Eve, invited but not accepted, can't read the closed group.
  - Hal and Jon stay suspended and banned.
  - Gus and Fay have no bundle or profile, so the app sends them to `/setup`.
- **Data the v2 migrations moved or added is right.**
  - Read markers moved to the owner-only `conversation_reads` (the future-dated one was clamped).
    `audience_members.last_read_at` was cleared for chats.
  - Existing chats are **not** switched to disappearing messages, and existing messages and posts get no
    expiry. Only **new** chats default to 4 weeks.
  - The notification type check kept every v1 type.
  - Orphaned `kw.rate_events` rows were removed before the new foreign key; live counters were kept.
- **The first run of each maintenance job deletes nothing from v1**: `ephemeral_tick`, `story_maintenance`,
  `release_due_checkins`, `passkey_maintenance`, `transparency_maintenance` and `auth_maintenance`. No posts,
  messages, files, notifications or accounts are removed, and nothing goes to the media trash.
- **v2 writes work for v1 accounts.** They can post, post with a timer, confirm the recovery key, turn on a chat
  timer and reply in a v1 DM. A v1 account with v1 and v2 rows deletes cleanly.
- **The data map** classifies every table and column.

**No corrective migration was needed.** The only new migration, `20261027000100_classic_export.sql`, is a
feature for §5. Because it is new, it doesn't edit anything already applied to staging.

### 2.2 Things that would make `db push` fail on production (go/no-go check §3.1)

- `20261021000100_passkeys` aborts if **any** table in `public` has row level security off. v1's
  `20261019000001_integration` had the same check, so this only catches tables created by hand since.
- Production must be at exactly `20261020000100` with no unknown versions in
  `supabase_migrations.schema_migrations`. Otherwise `db push` refuses (or needs `--include-all`; don't use it).

### 2.3 Optional: rehearse on a copy of production data

This is the strongest check. It needs a **data-only** dump of production, taken read-only with the owner's
approval. The dump contains personal data: keep it on the coordinator's machine and delete it afterwards.

```sh
# Connection string: Dashboard → Connect → Session pooler (or direct), with the DB password.
pg_dump "$PROD_DB_URL" --data-only --column-inserts --no-owner \
  --schema=public --schema=kw --table=auth.users --table=auth.identities --table=auth.mfa_factors \
  -f prod-data.sql
bash supabase/launch/rehearse.sh --data prod-data.sql      # prints row-count changes + all pgTAP suites
rm prod-data.sql
```

If the local GoTrue's `auth.*` columns differ from production's, the load stops with a column error. Drop the
`--table=auth.*` options, then add `--disable-triggers` and accept that foreign keys to `auth.users` aren't
checked locally. The restore runs with `session_replication_role = replica`.

## 3. Go / no-go (all must be "go")

### 3.1 Checks (read-only)

| # | Check | Go when |
|---|---|---|
| 1 | CI on `v2` HEAD: `tsc`, `eslint src` (0 errors), `vitest run`, `supabase test db`, `npm run build -w apps/web` | all green |
| 2 | `bash supabase/launch/rehearse.sh` (and §2.3 if done) | `REHEARSAL PASSED` |
| 3 | Staging has `20261027000100_classic_export` applied and Settings → Your data works there | yes |
| 4 | **Staging smoke with the before-user-created hook enabled exactly as in production**: passkey sign-up, passphrase sign-up, legacy email sign-in, recovery from a @handle (§8 list) | all pass. GoTrue v2.197 was checked in phase 6: admin `createUser`, which the passkey routes use, does **not** call the hook. Only `/signup` does. Hosted GoTrue may be newer, so check it here. |
| 5 | Production SQL (read-only): `select version from supabase_migrations.schema_migrations order by 1 desc limit 3;` | top = `20261020000100` |
| 6 | `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity;` | no rows |
| 7 | `select jobname, schedule, active from cron.job;` | `kithwall-auth-maintenance` present and active |
| 8 | `select dispatch_url from kw.push_config;` | `https://www.kithwall.com/api/push/dispatch` |
| 9 | `select key, value from public.app_settings;` | note `public_audience_enabled`. Kithwall 2 doesn't offer Public posts. If it is `true`, v1 public posts (Pages, open groups, public events) stay readable by every signed-in account, as in v1. Decide whether to switch it off after launch: the Classic export of Pages works either way. |
| 10 | Vercel env vars per §4 present in **Production** (and Preview where noted) | yes |
| 11 | A fresh backup exists (§5 step 3) | yes |
| 12 | Owner decision on the rpID (§4.2) | confirmed |

### 3.2 Who does what

| Step | Owner | Coordinator |
|---|---|---|
| User notice, maintenance window, approve backup / rewrite / push / merge / public repo | ✔ | |
| Everything else in §5, in order, pausing at each "owner approves" line | | ✔ |

## 4. Production configuration deltas

### 4.1 Vercel environment variables (`kithwall-web`, Production; Preview only where noted)

| Variable | Today | v2 needs | Action |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | set | same | none |
| `NEXT_PUBLIC_SITE_URL` | `https://www.kithwall.com` | same. It sets the passkey rpID, see 4.2. | none |
| `SUPABASE_SECRET_KEY`, `AUTH_HOOK_SECRET`, `ALTCHA_HMAC_KEY`, `CRON_SECRET` | set | same | none |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_DISPATCH_SECRET` | set | same. Don't rotate VAPID: it breaks every web-push subscription. | none |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | set | calls (relay) | none |
| **`SMTP_URL`, `MAIL_FROM`** | **not in the list of set variables: check** | content-free notice emails: deletion scheduled, recovery started, account recovered, notice-email verification. Without them these are **silently skipped**. | set (docs/deploy.md §2) |
| `PASSKEY_RP_ID`, `PASSKEY_ORIGINS`, `NEXT_PUBLIC_PASSKEY_RP_ID` | not set | optional | leave unset. Optionally set `PASSKEY_RP_ID=www.kithwall.com` to pin the decision (same result). |
| `NEXT_PUBLIC_CLASSIC_RETIRE_DATE` | n/a | optional, new: `YYYY-MM-DD` of the +30-day drop. It adds "will be deleted on …" to the Classic export card. | set at launch (launch day + 30) |
| `NEXT_PUBLIC_SOURCE_REPO`, `NEXT_PUBLIC_DONATE_*` | n/a | optional (About / Donate pages, owned by the polish stream) | set when the repo is public and donations open |
| `NEXT_PUBLIC_COMMIT_SHA` | n/a | automatic from `VERCEL_GIT_COMMIT_SHA` | none |
| `ANDROID_CERT_SHA256`, `APPLE_TEAM_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_KEY_P8`/`APNS_BUNDLE_ID` | not set | native apps only (05-native.md owner checklist). Until set: `assetlinks.json` is `[]`, AASA is 404, there is no native push. **The web launch doesn't need them.** | later |

| `TRUSTED_PROXY_HOPS` | n/a | optional, new (security review L6): how many proxies append to `X-Forwarded-For` in front of the app. Default 1 (Vercel, or one nginx/Caddy when self-hosting); on Vercel the platform's `x-real-ip` is used. Only change it for self-hosting behind several proxies. | none |

`NEXT_PUBLIC_*` values are baked in at build time. After changing any of them, redeploy.

`NEXT_PUBLIC_SITE_URL` is also **required for mail** in production (security review L8): without it, notice emails are not sent rather than linking to whatever host the request named. `ALTCHA_HMAC_KEY` (or `SUPABASE_SECRET_KEY`) must be set: the passphrase lookup now fails closed without a secret for its decoys (W3), and the recovery routes require a proof-of-work (W4).

### 4.2 Passkey rpID: confirm before launch, it cannot change later

With `NEXT_PUBLIC_SITE_URL=https://www.kithwall.com` and no `PASSKEY_RP_ID`, the server's rpID is
**`www.kithwall.com`**. Its origins are `https://www.kithwall.com` plus Android app origins once
`ANDROID_CERT_SHA256` is set. The client (`clientRpId()`) resolves to the same value. That is the decision
recorded in `05-native.md` §2. It is the right one because the apex `kithwall.com` is a Vercel 308 redirect, so
it can't serve `/.well-known/*` without a redirect.

Consequences:
- Every passkey is bound to `www.kithwall.com`. Moving the site to the apex, or changing the rpID, later
  invalidates **all** passkeys. Accounts would then need their passphrase or recovery key.
- Passkeys made on staging or preview domains don't work in production, which is expected.

**Owner: confirm `www.kithwall.com`.**

### 4.3 Supabase Auth (Dashboard → Authentication), production

| Setting | Required value | Why |
|---|---|---|
| Site URL | `https://www.kithwall.com` | email links |
| Redirect URLs | `https://www.kithwall.com/**` (covers `/recover/reset`, where the v1 "forgot password" email lands) | `resetPasswordForEmail(..., { redirectTo: origin + '/recover/reset' })` |
| Email provider | enabled; "Confirm email" on | v1 accounts sign in with email + password. v2 accounts use synthetic `@id.kithwall.invalid` addresses that are created confirmed, so no email is ever sent to them. |
| Before User Created hook | unchanged: `https://www.kithwall.com/api/hooks/before-user-created` with `AUTH_HOOK_SECRET` | v2 still uses it for any `/signup`. Passkey and passphrase sign-ups use admin `createUser` and check ALTCHA and `signups_enabled` themselves (01-accounts.md §2). |
| MFA (TOTP) | enabled (enroll + verify) | v1 accounts with TOTP. The v2 sign-in asks for the code (§8). |
| Email OTP / magic-link expiry | default 3600 s is fine | passkey sign-in redeems an admin magic-link `hashed_token` immediately; no email is sent |
| Email templates | **Review the wording.** "Confirm signup" and "Reset password" may say "Kithwall" in v1 terms or link to v1 pages. Keep them content-free. The reset link must go to `{{ .RedirectTo }}`, which is `/recover/reset`, or `{{ .SiteURL }}`. | v1 users who forgot their password |
| Rate limits, leaked-password protection, JWT/refresh settings | as in deploy.md | |
| `pg_net`, `pg_cron` | enabled already (v1 migrations) | |

## 5. Cutover, step by step

Times are relative to T (the start of the window). Allow 60 to 90 minutes.

**T−7 days: notice.** Post an in-app or email notice to v1 users. Say what is coming (Kithwall 2, passkeys, the
new design), that they keep their account, posts, photos, connections and messages, and that they sign in with
their email + password, after which a passkey is offered. Pokes, Kithville, Pages and Questions go away; they
can download them from Settings → Your data → "Kithwall Classic data" until launch + 30 days. Give the window
time.

**T−1 day.** Run the §3 go/no-go checks. Apply `20261027000100_classic_export.sql` to **staging** and smoke-test
staging. Agree with the owner on `NEXT_PUBLIC_CLASSIC_RETIRE_DATE` (T + 30 days).

1. **Freeze** *(owner approves)*. In production `/mod` → operator settings, set `signups_enabled = false`, so no
   v1 sign-ups land mid-cutover. Tell the other agents and contributors to commit and push all work on `v2`,
   then stop pushing.

2. **Last look at v1.** Note the current production deployment ID: Vercel → Deployments → the one aliased to
   www.kithwall.com. This is the rollback target. Note it in the log.

3. **Backup** *(owner approves; read-only on production)*.
   - Supabase Pro includes daily backups with 7-day retention. Point-in-time recovery (PITR) is a **paid
     add-on**, not part of Pro. Check Dashboard → Database → Backups for the latest daily backup and whether
     PITR is on.
   - Also take a manual dump right now, because `db push` is the risky step:
     ```sh
     npx supabase db dump --linked -f backup/prod-schema-$(date +%F).sql
     npx supabase db dump --linked --data-only -f backup/prod-data-$(date +%F).sql
     npx supabase db dump --linked --role-only -f backup/prod-roles-$(date +%F).sql
     ```
     Or use `pg_dump "$PROD_DB_URL" -Fc -f prod-$(date +%F).dump` for one restorable file. Store it outside the
     repo, encrypted. Storage objects aren't in the dump, and `db push` doesn't touch them.

4. **Rewrite history: author and committer emails** *(owner approved; executed by the coordinator; destructive
   for every clone)*. Every author, committer and tagger email becomes
   `275127984+443abdul@users.noreply.github.com`. Today the history has `[personal email]` (21 commits)
   and `[personal email]` (9 commits), and an annotated tag `v1-classic`. Work in a fresh mirror, never in
   the working copy:
   ```sh
   pip install git-filter-repo            # or: brew/scoop install git-filter-repo
   git clone --mirror https://github.com/443abdul/kithwall.git kithwall-rewrite.git
   cd kithwall-rewrite.git
   git filter-repo --force --email-callback 'return b"275127984+443abdul@users.noreply.github.com"'
   # verify: only the noreply address is left (authors, committers, taggers)
   git log --all --format='%ae%n%ce' | sort -u
   git for-each-ref refs/tags --format='%(taggeremail)' | sort -u
   git remote add origin https://github.com/443abdul/kithwall.git     # filter-repo removes the remote
   git push --force origin 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*'
   ```
   Fallback without filter-repo (slower, same result):
   ```sh
   git filter-branch --env-filter '
     export GIT_AUTHOR_EMAIL=275127984+443abdul@users.noreply.github.com
     export GIT_COMMITTER_EMAIL=275127984+443abdul@users.noreply.github.com' \
     --tag-name-filter cat -- --all
   ```
   (`--tag-name-filter cat` rewrites `v1-classic` but keeps its tagger email. Re-create the tag afterwards with
   `GIT_COMMITTER_EMAIL=… git tag -a -f v1-classic <new sha> -m "Kithwall Classic"`.)
   Push `main`, `v2` and the tags. Avoid `--mirror` on push: GitHub refuses `refs/pull/*`.
   - Commit messages are unchanged: the `Co-Authored-By` trailers stay. Commit and tag signatures, if any, are
     dropped.
   - The force-push to `main` triggers a Vercel production build of the **same v1 code**. That's harmless, but
     wait for it to finish (or cancel it) before step 6.
   - Afterwards, every clone, including the agents' and the owner's, must re-clone or run
     `git fetch && git reset --hard origin/<branch>`. Old SHAs in notes, docs or Vercel deployment metadata no
     longer resolve; Vercel deployments themselves keep working.
   - GitHub may keep cached views of old commits for a while. Contact GitHub support if they must be purged.

5. **Database** *(owner approves)*. From an up-to-date clone of `v2`:
   ```sh
   npx supabase link --project-ref uvuojqziktbwxkjzeiar      # already linked; check with: npx supabase projects list
   npx supabase migration list --linked                      # remote = 20261020000100; local adds 11
   npx supabase db push --linked --dry-run                   # lists exactly 20261021000100 … 20261027000100
   npx supabase db push --linked
   ```
   Then, read-only:
   ```sql
   select jobname, schedule, active from cron.job order by 1;           -- 6 kithwall-* jobs
   select count(*) from public.conversations where disappear_secs is not null;   -- 0 (existing chats unchanged)
   select count(*) from public.conversation_reads;                      -- ≈ number of v1 read markers
   select count(*) from kw.data_map_tables;                             -- > 60
   ```
   The v1 site still runs during the few minutes between this step and step 7. That is safe: the schema is
   additive for it (§7), except that chats it creates in those minutes default to disappearing after 4 weeks.

6. **Environment** *(owner approves)*. Apply §4.1 (at least `SMTP_URL` and `MAIL_FROM` if missing, and
   `NEXT_PUBLIC_CLASSIC_RETIRE_DATE`), plus the §4.3 dashboard settings (templates, redirect URLs).

7. **Merge and deploy** *(owner approves)*. `main` is an ancestor of `v2`, so it fast-forwards:
   ```sh
   git checkout main && git pull
   git merge --ff-only v2
   git push origin main
   ```
   Vercel builds `main` (Root Directory `apps/web`) and promotes it. Watch the build log. Then check the
   production deployment has the new commit SHA (Settings → About shows the build).

8. **Smoke tests** (§8). If anything in the "stop" column fails, go to §7 (rollback).

9. **Reopen.** Set `signups_enabled = true` in `/mod`.

10. **Make the repository public** *(owner approves)*. Check first:
    - The rewritten history has no secrets: `git log -p --all | grep -nE "sb_secret_|whsec_|BEGIN (EC|RSA) PRIVATE|VAPID_PRIVATE_KEY=."`
      Only the local dev values in `supabase/config.toml` and the documented public publishable key are
      expected.
    - There is no `.env*` with real values: `git log --all -- '*.env*'`.
    - README, LICENSE and SECURITY are in place (polish stream).

    Then GitHub → Settings → General → Danger zone → Change visibility → Public. Set
    `NEXT_PUBLIC_SOURCE_REPO` if the About and Transparency pages need it, then redeploy.

11. **Post-launch monitoring** (first 48 h, then daily for a week):
    - Vercel → Logs: 5xx on `/api/auth/passkey/*`, `/api/push/dispatch`, `/api/recovery/*`, `/api/cron/*`.
    - Supabase → Logs → Auth: sign-in failures, `email_not_confirmed`, hook errors. Postgres: errors and slow
      queries.
    - `select status_code, count(*) from net._http_response where created > now() - interval '1 hour' group by 1;`
      Expect mostly 200. 403 means the dispatch secret doesn't match; 503 means VAPID or FCM is missing.
    - `select jobname, status, count(*) from cron.job_run_details d join cron.job j using (jobid) where start_time > now() - interval '1 day' group by 1, 2;`
      There should be no failed runs.
    - Vercel cron runs (Settings → Cron Jobs) once a day for each of the three paths.
    - Support inbox: v1 users who can't sign in. The usual causes are a forgotten password (→ `/recover`) and a
      lost TOTP device (admin removes the factor after out-of-band verification, deploy.md §5).

12. **T + 30 days: retire Kithwall Classic data** (§9).

## 6. Vercel Hobby limits

| Item | Status |
|---|---|
| Crons | `apps/web/vercel.json` has 3 crons, all **daily**: `0 3 * * *` (account deletions), `15 4 * * *` (story media), `30 4 * * *` (ephemeral media trash). Hobby allows only daily schedules, and runs them at some point within the scheduled hour. Nothing needed changing. Everything time-critical runs in pg_cron in the database; the web crons only remove storage objects (and as a backstop, `kw.auth_maintenance` deletes overdue accounts 24 h late). |
| Function duration | `/api/cron/*` set `maxDuration = 60`, `/api/link-preview` 15, `/api/calls/turn` 10. All are within Hobby's limits: 60 s without Fluid compute, up to 300 s with it. `/api/push/dispatch`, `/api/push/test` and the auth routes don't set it. **Risk:** if Fluid compute is off for the project, their default is 10 s. A dispatch fanning out to many devices (web push + FCM + APNs) could hit that. Check Project → Settings → Functions → Fluid compute (default on for new projects), or add `export const maxDuration = 30` to the dispatch route. The cron routes work in rounds of ≤ 500 objects, so they stay well inside 60 s. |
| Function size | The production build in phase 6 succeeded. `.next/server` is about 35 MB, well under the 250 MB unzipped limit. |
| Fair use | Hobby is for non-commercial use. Kithwall is free with optional donations. Revisit the plan if donations open or traffic grows: function invocations, bandwidth and image optimization have Hobby caps. |

## 7. Rollback

**Web: instant.** Vercel → Deployments → the v1 deployment noted in step 2 → "Instant Rollback". www.kithwall.com
serves v1 again within seconds. Revert `main` afterwards (`git revert` the merge range, or force-push the
pre-merge SHA) so the next push doesn't redeploy v2.

**Database: stays on v2.** Don't restore unless data was lost. The v2 migrations are additive:

- new tables;
- new nullable columns (`events.group_id`, `media_objects.story_id`, `conversations.disappear_*`,
  `messages.expires_at/edited_at/unsent_at/notice`, `posts.publish_at/disappear_secs/expires_at`,
  `comments.edited_at`);
- check constraints only widened;
- new functions, policies and cron jobs.

v1 code keeps working on it. **Not** additive, with what each means for a rolled-back v1:

| Change | Effect on v1 after a rollback | Mitigation |
|---|---|---|
| Read markers moved to `conversation_reads`; `audience_members.last_read_at` cleared for chats and nulled on every write by a trigger | v1 shows chats as unread and can't clear them | cosmetic. To restore, copy markers back: `update audience_members m set last_read_at = r.last_read_at from conversation_reads r join conversations c on c.id = r.conversation_id where m.audience_id = c.audience_id and m.member_id = r.user_id;` after `drop trigger conversation_member_no_read_marker on public.audience_members;` |
| `conversations.disappear_secs` default 4 weeks for **new** chats | chats v1 creates disappear after 4 weeks without v1 showing it | `alter table public.conversations alter column disappear_secs drop default;` (reversible) |
| `kw.rate_events` orphans deleted + FK | none | none |
| v1 functions replaced (`feed_posts`, `can_read_post`, `can_read_media`, `pending_key_deliveries`, `leave_conversation`, `conversation_previews`, `push_plan`, `create_key_challenge`, guards) | v2 semantics. Scheduled and expired posts stay hidden, and leaving a chat hands it to a successor. v1 still works. | none |
| `push_on_message` trigger replaced by the v2 push enqueue | the v1 `/api/push/dispatch` receives v2 job shapes. Pushes may fail; content is never exposed. | accept for a short rollback |
| Accounts created in v2 (passkey / passphrase) | can't sign in to v1: there is no passkey login, and the synthetic email is unknown to them | roll forward quickly |
| v2-only content (stories, reactions, notices, circle events, disappearing / scheduled posts) | invisible or ignored in v1 | none |

**Full database restore** is only for data loss. Use PITR if enabled, otherwise the step 3 dump into a **new**
project, or the daily backup. Restoring discards everything written after the backup.

## 8. Smoke tests (production, right after step 7)

| # | Test | Stop if it fails? |
|---|---|---|
| 1 | `/`, `/signin`, `/join`, `/help`, `/legal/privacy`, `/transparency` load; response headers have CSP with nonce, HSTS, `Referrer-Policy: no-referrer` | yes |
| 2 | **v1 account** (owner's own or a test account made in v1 before the cutover): Sign in → "Sign in with email" → email + password → "Add a passkey?" (try both "Add passkey" and "Not now") → Home shows the v1 posts decrypted and the **"Save your recovery key"** nudge | yes |
| 3 | v1 account **with TOTP**: email + password → "Two-step verification" → code → "Add a passkey?" → Home | yes |
| 4 | v1 account that never finished `/welcome`: email + password → `/setup` ("Finish setting up your account") | no (rare) |
| 5 | New **passkey** sign-up on `/join` (production hook on), then sign out, then "Sign in with passkey" | yes |
| 6 | New **passphrase** sign-up, then sign in with @handle + passphrase | yes |
| 7 | Messages: a v1 DM opens with history. Send, edit, react, unsend. A new chat shows the 4-week timer. | yes |
| 8 | Post with a photo; comment; like; story; album. The Classic data card appears in Settings → Your data for v1 accounts and downloads a ZIP. | no |
| 9 | Push: Settings → Notifications → test notification. A friend messages while the app is closed. Check `net._http_response`. | no |
| 10 | `/recover` with a @handle and the recovery key, on a throwaway account | no |
| 11 | Call between two test accounts (TURN relay) | no |
| 12 | `/you/privacy-report` loads; account deletion of a throwaway account | no |
| 13 | `select * from cron.job_run_details order by start_time desc limit 10;` shows succeeded runs of the minute jobs | yes |

Phase 6 walked through rows 2 to 4 locally on real v1-encrypted accounts (`supabase/launch/v1_accounts.local.test.ts`):
- legacy sign-in → passkey offer → Home with v1 posts decrypted and the recovery nudge;
- TOTP → passkey offer;
- no keys → `/setup`;
- the Classic export decrypted pokes, the Kithville farm and gift, Pages with their posts, the liked Page, the
  question with its vote tally, the friend list name and members, and the check-in, life-event and Kithville
  posts.

Fixed along the way:
- A v1 account without keys now goes to `/setup`. Before, it showed "check your email and password".
- An unconfirmed v1 email no longer shows "Can't reach Kithwall". It now gets the generic sign-in failure.
- v1 accounts now get the recovery-key nudge on their first sign-in on a device.

## 9. Launch + 30 days: drop the Classic tables

`supabase/launch/drop_classic_tables.sql` is kept outside `supabase/migrations`, so `db push` can never apply it
early. It deletes Page posts, Kithville posts and the v1-only notification types. It drops `pokes`, `pages`,
`page_likes`, `poll_votes`, `game_state` and `game_actions`, with their guards, the Page policies and the
`classic_*` and `page_like_count` functions. It removes them from the data map and tightens the checks on
`posts` and `notifications`.

It deliberately keeps:
- `tag_notices`, which v2 albums still use;
- `posts.page_id`, which is always null afterwards and still named by the v2 client;
- `push_preferences.pokes`, still read by `lib/push.ts`;
- friend lists;
- question, check-in and life-event posts.

No cron job, type, bucket or Vercel cron belonged to these features. It was tested on the rehearsal database:
it applies cleanly and `transparency.test.sql` still passes.

Procedure:
1. Copy it to `supabase/migrations/<timestamp>_drop_classic.sql` in a PR that also:
   - removes the Classic part of `lib/export.ts` (`hasClassicData`, `collectClassic`, `buildClassicExport`,
     the `classic` export step) and `ClassicSection` in `components/settings/DataSettings.tsx`, plus the
     `classic.*` i18n keys;
   - deletes `supabase/tests/classic_export.test.sql`;
   - updates the fixtures that still use the dropped tables or the notification type `'poke'`:
     `community.test.sql` (Pages, Kithville), `social.test.sql` (poll votes), `rls.test.sql` tests 44–45,
     `push.test.sql` tests 22/26/29 and `native_push.test.sql` tests 26–28 (use `'friend_request'` instead of
     `'poke'`);
   - optionally removes `20261027000100_classic_export`'s functions (the drop script already does).
2. `bash supabase/launch/rehearse.sh` on the PR branch, then CI.
3. Backup (step 3 above), then `npx supabase db push --linked`, then the `/you/privacy-report` and export smoke
   tests.
4. Unset `NEXT_PUBLIC_CLASSIC_RETIRE_DATE`.

## 10. Files (phase 6)

| File | What |
|---|---|
| `supabase/launch/rehearse.sh` | throwaway-database rehearsal (§2) |
| `supabase/launch/seed_v1_sample.sql` | v1-shaped data of every kind |
| `supabase/launch/verify_cutover.sql` | 88 pgTAP assertions run after the v2 migrations |
| `supabase/launch/v1_accounts.local.test.ts` | real v1-encrypted accounts in the **local** stack for the browser walk-through (`npx vitest run --root supabase/launch`; `KW_LAUNCH_CLEANUP=1` deletes them) |
| `supabase/launch/drop_classic_tables.sql` | +30 days, **do not apply before** (§9) |
| `supabase/migrations/20261027000100_classic_export.sql` + `supabase/tests/classic_export.test.sql` | caller-only `classic_liked_pages()` / `classic_page_posts()` |
| `apps/web/src/lib/export.ts`, `components/settings/DataSettings.tsx` | "Kithwall Classic data": in the full ZIP (`data/classic/`) and as its own download |
| `apps/web/src/lib/auth/account-impl.ts`, `lib/auth/login.ts` | `/setup` redirect, unconfirmed-email error, recovery nudge for v1 accounts |
