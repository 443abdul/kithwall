# Kithwall

*Your 2010 social network, sealed.*

Kithwall is a faithful recreation of 2010-era social networking — the Wall, News Feed, photo
albums with tags, pokes, chat, groups and events — where everything you share with friends is
**end-to-end encrypted**. No ads, no tracking, no algorithmic feed you didn't ask for.

## Status
Releases 1 and 2 are built, tested and integrated:

| Area | What works |
|---|---|
| Accounts | Sign-up (self-hosted proof-of-work), encryption keys, 24-word recovery key, trusted-friend recovery, two-step verification, data export, account deletion |
| Social | News Feed (Top News / Most Recent), Wall, likes, comments, shares, friend lists, pokes, notifications, Dec 2010 profiles, notes, questions, places |
| Photos | Encrypted albums, tagging, comments, profile pictures; location metadata stripped on device |
| Messages | One-to-one and group conversations, chat dock, private presence and typing, key rotation |
| Community | Closed and secret groups, events with RSVP, Pages (when Public is switched on), Kithville |
| Safety | Reporting with verifiable disclosure, moderation console, admin settings |

Tests: 116 crypto tests, 304 database (RLS) tests, CI on every push. The database is live on the
Supabase project `kithwall`.

## Documents
[Foundation](docs/01-foundation.md) · [Scope](docs/02-scope.md) · [Specification](docs/03-spec.md) ·
[Developer guide](docs/dev-guide.md) · [Deploying](docs/deploy.md) · [Legal drafts](docs/legal/README.md)

The visual reference is [`reference/theassbook-2010.html`](reference/theassbook-2010.html).

## Deploy
Vercel → import this repository → **Root Directory `apps/web`** → add the environment variables from
[docs/deploy.md](docs/deploy.md#2-vercel-project) → deploy. Then finish the Supabase Auth settings
(site URL, sign-up hook, SMTP, MFA) from the same document.

## Local development
```sh
npm install
supabase start                          # local database (ports 643xx, see supabase/config.toml)
npm run dev                             # http://localhost:3000
supabase test db                        # RLS tests
npx vitest run --root packages/crypto   # crypto tests
```
