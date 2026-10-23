# Kithwall — Deploying to Production

This is the checklist for putting Kithwall on Vercel + Supabase. Read [03-spec.md](03-spec.md) §7 and §9
first. Everything here is configuration; no secrets belong in the repository.

## 1. Supabase project

> **Status (2026-10-17):** project **kithwall** (ref `uvuojqziktbwxkjzeiar`, ap-south-1) exists and every migration in
> `supabase/migrations` is applied (`supabase db push --linked`). Steps 1–2 are done; do the Auth settings below.

1. Create the project (region close to your users). Note the **project URL**, the **publishable key**
   and a **secret key** (Project Settings → API Keys).
2. Apply migrations from the repo root:
   ```sh
   supabase link --project-ref <ref>
   supabase db push            # applies supabase/migrations/*.sql in order
   ```
   Only after CI is green. Never edit the production schema by hand.
3. Database → Extensions: make sure **pg_cron** is enabled (the `20261018000100_auth_safety` migration
   creates it and schedules `kithwall-auth-maintenance` hourly). Check with
   `select jobname, schedule from cron.job;`.
4. Storage: the `media` bucket is created by migration (private, 30 MiB limit). Don't make it public.

### Auth settings (Dashboard → Authentication)

| Setting | Value |
|---|---|
| **Site URL** | `https://<your-domain>` |
| **Redirect URLs** | `https://<your-domain>/**` (and the Vercel preview pattern if you use previews, e.g. `https://*-<team>.vercel.app/**`) |
| Email provider | Enabled (Supabase needs it for the synthetic `u…@id.kithwall.invalid` sign-in addresses, which are created already confirmed; no email is ever sent to them). Public email sign-ups are refused by the before-user-created hook below |
| Email confirmations | On (irrelevant for Kithwall accounts, which are created confirmed by the server) |
| **MFA** | TOTP **enabled** (enroll + verify). Phone MFA off |
| **JWT expiry** | 3600 s; refresh-token rotation **on**, reuse interval 10 s |
| Session timebox / inactivity | Optional (e.g. inactivity 30 days) |
| Anonymous sign-ins | Off. Manual linking off. All OAuth providers off |
| **Rate limits** | Sign-ups/sign-ins: 30 per 5 min per IP, Token verifications: 30 per 5 min, Token refreshes: 150 per 5 min |

Accounts have **no email and no password** (docs/v2/01-accounts.md): passkey accounts and passphrase accounts
(@handle + passphrase, Argon2id salted with the synthetic address) only. Never change a user's auth email
from the dashboard: the passphrase salt is derived from it, so the passphrase would stop opening the keys.

### Custom SMTP (Spacemail Pro)

Authentication → Emails → SMTP Settings:

| Field | Value |
|---|---|
| Host | `mail.spacemail.com` (confirm in Spacemail → mail client settings) |
| Port | `465` (SSL/TLS) |
| Username | the full mailbox address, e.g. `no-reply@<your-domain>` |
| Password | the mailbox password (store it only in Supabase and Vercel) |
| Sender name / email | `Kithwall` / `no-reply@<your-domain>` |

Set SPF, DKIM and DMARC for the domain as Spaceship/Spacemail documents, then send a test email.
Supabase's own email templates are never used by Kithwall (no confirm or reset emails); the app sends its
content-free notices itself through `SMTP_URL`.

### Before-user-created hook (sign-up anti-abuse)

Authentication → Hooks → **Before User Created** → HTTP:

- URL: `https://<your-domain>/api/hooks/before-user-created`
- Generate a secret in the dashboard (it looks like `v1,whsec_<base64>`) and put **the same string** in
  Vercel as `AUTH_HOOK_SECRET`.

Kithwall accounts are created by `/api/auth/passkey/register/*` with the admin API, which doesn't run this
hook; those routes check `app_settings.signups_enabled` and a single-use ALTCHA proof-of-work themselves.
The hook verifies the Standard-Webhooks signature and **refuses every other sign-up** (GoTrue's public
`/signup` with an email and password), letting through only users whose `app_metadata.kw_account` the admin
API set, in case a newer GoTrue also runs it for admin creation. If the hook is down, public sign-ups fail
closed.

**Local development:** `supabase/config.toml` already configures the hook for
`http://host.docker.internal:3000/api/hooks/before-user-created` with a local-only secret that matches
`apps/web/.env.local`. It takes effect after `supabase stop && supabase start` and then requires a dev
server on port 3000. Without the restart (or with the hook disabled) the app works the same, just
without the server-side ALTCHA check.

## 2. Vercel project

Import the GitHub repo, **Root Directory `apps/web`**, framework Next.js. Environment variables
(Production and Preview; never expose server-only ones with `NEXT_PUBLIC_`):

| Variable | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | `https://uvuojqziktbwxkjzeiar.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | all | `sb_publishable_pGgH8XOXbF-G1r5ABWCuwg_4MZpKg_B` (public by design) |
| `NEXT_PUBLIC_SITE_URL` | all | `https://<your-domain>` (used in notice emails) |
| `SUPABASE_SECRET_KEY` | server only | secret key — used only by `/api/account/*`, `/api/hooks/*`, `/api/recovery/notify`, `/api/cron/*`, `/api/altcha/challenge`, `/api/push/*` |
| `ALTCHA_HMAC_KEY` | server only | 32+ random characters (`openssl rand -base64 48`) |
| `AUTH_HOOK_SECRET` | server only | the hook secret from Supabase (`v1,whsec_…`) |
| `CRON_SECRET` | server only | 32+ random characters; Vercel Cron sends it as `Authorization: Bearer …` |
| `SMTP_URL` | server only | `smtps://no-reply%40<your-domain>:<url-encoded password>@mail.spacemail.com:465` — content-free notices to verified notice addresses (notice-email verification, recovery started, account recovered, new sign-in method) |
| `MAIL_FROM` | server only | `Kithwall <no-reply@<your-domain>>` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | all | Web Push public key (public by design) — see "Push notifications" below |
| `VAPID_PRIVATE_KEY` | server only | Web Push private key |
| `VAPID_SUBJECT` | server only | `mailto:security@kithwall.com` |
| `PUSH_DISPATCH_SECRET` | server only | 32+ random characters; must equal `kw.push_config.secret` in the database |
| `VERCEL_GIT_COMMIT_SHA` | set by Vercel | Inlined at build time as `NEXT_PUBLIC_COMMIT_SHA` (next.config.ts) so the footer and Settings → Help & about link to the exact source of the running build (AGPL-3.0 §13). Outside Vercel, set `NEXT_PUBLIC_COMMIT_SHA` to the deployed commit yourself |
| `NEXT_PUBLIC_SOURCE_REPO` | all, optional | Forks only: your public repository URL (https). Default `https://github.com/443abdul/kithwall` |
| `NEXT_PUBLIC_DONATE_MONERO` | all, optional | Monero address (standard 4…/subaddress 8…, 95 chars, or integrated 106). Shows the address, an on-device QR code and a copy button on /donate. **Not set at launch** |
| `NEXT_PUBLIC_DONATE_BITCOIN` | all, optional | Bitcoin mainnet address (bc1… with valid checksum, or legacy 1…/3…). Address + QR, with a note that Bitcoin payments are public. Not set at launch |
| `NEXT_PUBLIC_DONATE_BTCPAY_URL` | all, optional | https link to a self-hosted BTCPay payment page (button). Not set at launch |
| `NEXT_PUBLIC_DONATE_SPONSOR_URL` | all, optional | https link to a fiscal sponsor's donation page (button). Not set at launch |

Turn **off** Vercel Web Analytics and Speed Insights (spec §7). Keep the shortest log retention.

### Donations (/donate)

Kithwall takes no donations yet, so /donate only shows "Other ways to help". Each method appears **only when its
`NEXT_PUBLIC_DONATE_*` variable is set and passes the format check** in `apps/web/src/lib/donate.ts` (invalid values are
silently ignored, so check the page after deploying). They are inlined at build time: redeploy after changing them.
Double-check every address against your wallet; the check is about format, not ownership. In the iOS app the methods
are replaced by a pointer to the website (App Store rules for donation links).

### Cron

`apps/web/vercel.json` has two daily crons (daily works on every Vercel plan; set `CRON_SECRET` in Vercel):
`/api/cron/stories` and `/api/cron/ephemeral`. Account deletion is immediate (`/api/account/delete`, proof-of-key),
so no cron is involved.

Stories (24 h) expire in the database: expired stories are hidden at once and a `pg_cron` job
(`kithwall-story-maintenance`, every 10 minutes) deletes the rows. Their encrypted photos stay in the
bucket, unreadable to everyone but the author, until `GET /api/cron/stories` removes them (daily in
`vercel.json`; on a Vercel plan with hourly crons, `"30 * * * *"` keeps the bucket tidier).

Disappearing messages and posts, unsend and scheduled posts (`20261024000100_ephemeral`): the
`kithwall-ephemeral` `pg_cron` job runs every minute — it publishes due scheduled posts (and notifies
their authors, which sends the push), deletes expired messages and posts and old unsend tombstones.
Every media row that goes away leaves its storage path in a private trash list (`kw.media_trash`); the
objects are unreadable from that moment and `GET /api/cron/ephemeral` (daily in `vercel.json`, same
`CRON_SECRET`) deletes them from the bucket.

### Push notifications (Web Push)

1. Generate the keys once (keep them; rotating the VAPID pair silently breaks every existing
   subscription until each person reopens Kithwall):
   ```sh
   node apps/web/scripts/gen-vapid.mjs
   ```
   It prints `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and a random
   `PUSH_DISPATCH_SECRET`. Add all four to Vercel (Production and Preview) and redeploy — the public key is
   baked into the client bundle at build time.
2. After `supabase db push` has applied `20261020000100_push.sql` (it enables **pg_net**), tell the database
   where to send push jobs (SQL editor; production only — never commit the secret):
   ```sql
   insert into kw.push_config (dispatch_url, secret)
   values ('https://www.kithwall.com/api/push/dispatch', '<PUSH_DISPATCH_SECRET>')
   on conflict (id) do update set dispatch_url = excluded.dispatch_url, secret = excluded.secret, updated_at = now();
   ```
   Use the canonical host (the one that doesn't redirect) — pg_net does not follow redirects. Without this
   row the triggers do nothing (inserts are never affected). Preview deployments get no pushes unless you
   point a separate database at them.
3. Check: Settings → Account → Push Notifications → turn on → **Send a test notification**. Then have a
   friend message you with Kithwall closed. Recent dispatch calls:
   `select id, status_code, left(content, 120), error_msg from net._http_response order by id desc limit 10;`
   (`{"ok":true,"sent":1,...}` is success; 403 = secret mismatch; 503 = VAPID env vars missing.)

**Local development:** `apps/web/.env.local` has a dev key pair. The local `kw.push_config` points at
`http://host.docker.internal:3000/api/push/dispatch` (the DB container reaches the host that way). Real
pushes need a browser with notification permission (Chrome/Edge/Firefox on `localhost`); embedded
browsers usually can't register service workers.

## 3. First admin

Sign up through the site, finish setup, then in the SQL editor:

```sql
insert into public.staff_roles (user_id, role)
select id, 'admin' from public.profiles where username = '<your username>';
```

From then on use **Account → Moderation & Admin** to appoint moderators (`grant_staff_role`) and change
operator settings (`signups_enabled`, `public_audience_enabled`, `recovery_wait_hours` — keep 24).
Admins should turn on two-step verification.

## 4. After deploying

- Visit `/join`, create a test account with a passkey, save the recovery key, sign in on a second browser
  (passkey, or @handle + passphrase for a passphrase account), and delete the test account from
  You → Settings → Your data.
- Check response headers on `/`: CSP with a per-request nonce + `strict-dynamic` (Trusted Types is deferred, spec §12), HSTS,
  `Referrer-Policy: no-referrer`, COOP `same-origin`.
- Check `/manifest.webmanifest`, `/icons/icon-192.png` and `/sw.js` load (installable PWA; the service worker
  only handles push and caches nothing). Chrome DevTools → Application → Manifest should show no errors.
- Check `select * from cron.job_run_details order by start_time desc limit 5;` after an hour.

## 5. Operational notes

- **Recovery requests** notify trustees in-app and email the owner's verified notice address, if any; the waiting period comes from
  `app_settings.recovery_wait_hours` (default 24, max 168). Closed requests are purged after 7 days.
- **MFA is enforced by the database**: once a user has a verified TOTP factor, every table and the media
  bucket require an `aal2` session (restrictive policy `require mfa when enrolled`). New tables in later
  migrations must call `select kw.require_mfa('public.<table>');`.
- **Lost authenticator:** there is no self-service bypass. After verifying the person out of band, an
  admin can delete the factor in Dashboard → Authentication → Users → (user) → MFA factors.
- **Reports** keep the reporter's disclosed plaintext and key for one year after resolution (spec §7.1);
  only staff can read them.
