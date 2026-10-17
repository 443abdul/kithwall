# Kithwall — Deploying to Production

This is the checklist for putting Kithwall on Vercel + Supabase. Read [03-spec.md](03-spec.md) §7 and §9
first. Everything here is configuration; no secrets belong in the repository.

## 1. Supabase project

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
| Email confirmations | **On** ("Confirm email") |
| Secure email change | On (email change isn't offered in v1 anyway; see below) |
| **Leaked password protection** | **On** (Password security → "Prevent use of leaked passwords"). Minimum length 10 |
| **MFA** | TOTP **enabled** (enroll + verify). Phone MFA off |
| **JWT expiry** | 3600 s; refresh-token rotation **on**, reuse interval 10 s |
| Session timebox / inactivity | Optional (e.g. inactivity 30 days) |
| Anonymous sign-ins | Off. Manual linking off. All OAuth providers off |
| **Rate limits** | Emails sent: 30/h (raise once SMTP is set), Sign-ups/sign-ins: 30 per 5 min per IP, Token verifications: 30 per 5 min, Token refreshes: 150 per 5 min |

**Email change is not supported in v1.** The Argon2 salt is derived from the email, so an email change
must re-wrap the key bundle in the same step. Until that flow exists, users are told to keep their email
account secure. Don't build a dashboard-side email change for users either: their keys would stop opening.

### Custom SMTP (Spacemail Pro)

Authentication → Emails → SMTP Settings:

| Field | Value |
|---|---|
| Host | `mail.spacemail.com` |
| Port | `465` (SSL/TLS) |
| Username | the full mailbox address, e.g. `no-reply@<your-domain>` |
| Password | the mailbox password (store it only in Supabase and Vercel) |
| Sender name / email | `Kithwall` / `no-reply@<your-domain>` |

Set SPF, DKIM and DMARC for the domain as Spaceship/Spacemail documents, then send a test email.
Email templates: keep them content-free (they only contain the confirm / reset link).

### Before-user-created hook (sign-up anti-abuse)

Authentication → Hooks → **Before User Created** → HTTP:

- URL: `https://<your-domain>/api/hooks/before-user-created`
- Generate a secret in the dashboard (it looks like `v1,whsec_<base64>`) and put **the same string** in
  Vercel as `AUTH_HOOK_SECRET`.

The route verifies the Standard-Webhooks signature, refuses sign-ups when `app_settings.signups_enabled`
is false, and requires a valid, unexpired, single-use ALTCHA proof-of-work (the sign-up form solves it
in the browser and sends it as `user_metadata.altcha`). If the hook is down, sign-ups fail closed.
Users created from the dashboard also pass through the hook; temporarily disable it if you need to
create one by hand.

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
| `NEXT_PUBLIC_SUPABASE_URL` | all | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | all | publishable key |
| `NEXT_PUBLIC_SITE_URL` | all | `https://<your-domain>` (used in notice emails) |
| `SUPABASE_SECRET_KEY` | server only | secret key — used only by `/api/account/*`, `/api/hooks/*`, `/api/recovery/notify`, `/api/cron/*`, `/api/altcha/challenge` |
| `ALTCHA_HMAC_KEY` | server only | 32+ random characters (`openssl rand -base64 48`) |
| `AUTH_HOOK_SECRET` | server only | the hook secret from Supabase (`v1,whsec_…`) |
| `CRON_SECRET` | server only | 32+ random characters; Vercel Cron sends it as `Authorization: Bearer …` |
| `SMTP_URL` | server only | `smtps://no-reply%40<your-domain>:<url-encoded password>@mail.spacemail.com:465` — content-free notices (recovery started, deletion scheduled) |
| `MAIL_FROM` | server only | `Kithwall <no-reply@<your-domain>>` |

Turn **off** Vercel Web Analytics and Speed Insights (spec §7). Keep the shortest log retention.

### Cron

Scheduled deletions ("I've lost everything", 72-hour wait) are carried out by
`GET /api/cron/account-deletions`, which removes the user's storage folder and then the auth user.
`apps/web/vercel.json` already contains (daily works on every Vercel plan; set `CRON_SECRET` in Vercel):

```json
{ "crons": [{ "path": "/api/cron/account-deletions", "schedule": "0 3 * * *" }] }
```

If the web cron never runs, the database job deletes overdue accounts after one extra day (rows and keys
are gone; the encrypted blobs left in storage are unreadable but should be swept — rerun the cron).

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

- Visit `/`, sign up a test account, confirm the email, save the recovery key, log in on a second browser
  with two-step verification, and delete the test account from Account Settings.
- Check response headers on `/`: CSP with a nonce and `require-trusted-types-for 'script'`, HSTS,
  `Referrer-Policy: no-referrer`, COOP `same-origin`.
- Check `/manifest.webmanifest` and `/icon.svg` load (installable PWA; no service worker in v1).
- Check `select * from cron.job_run_details order by start_time desc limit 5;` after an hour.

## 5. Operational notes

- **Recovery requests** notify trustees in-app and email the owner; the waiting period comes from
  `app_settings.recovery_wait_hours` (default 24, max 168). Closed requests are purged after 7 days.
- **MFA is enforced by the database**: once a user has a verified TOTP factor, every table and the media
  bucket require an `aal2` session (restrictive policy `require mfa when enrolled`). New tables in later
  migrations must call `select kw.require_mfa('public.<table>');`.
- **Lost authenticator:** there is no self-service bypass. After verifying the person out of band, an
  admin can delete the factor in Dashboard → Authentication → Users → (user) → MFA factors.
- **Reports** keep the reporter's disclosed plaintext and key for one year after resolution (spec §7.1);
  only staff can read them.
