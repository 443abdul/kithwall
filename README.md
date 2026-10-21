# Kithwall

*Your people. Your space. Sealed.*

Kithwall is a private social network for the people you actually know: family, friends and the circles
you belong to. Everything you post, send or store is **end-to-end encrypted on your device**, so nobody,
including us, can read, sell or exploit it. No ads, no tracking, no algorithmic feed.

Kithwall is free and open source under the [GNU Affero General Public License v3.0](LICENSE).

## What's in it

- **Home**: stories and a calm, chronological feed from your connections and circles.
- **Circles**: groups of people, each with its own feed, chat, albums, events and notes.
- **Messages**: one-to-one and group chats, voice notes, and end-to-end encrypted voice and video calls.
- **Albums, events, notes**, disappearing and scheduled posts, edit and unsend everywhere.
- **Safety centre**: app PIN, duress PIN, panic wipe, hidden chats, safety check-ins, device list.
- **Transparency**: a live "What Kithwall knows about you" page built from the server's actual rows,
  one-tap export, safety numbers, and a public transparency report.
- **Everywhere**: 12 languages (including right-to-left Urdu, Arabic and Persian), three visual styles
  with light and dark modes, an installable web app, and iOS and Android apps.

## Principles

1. **We can't see it.** Content, names, photos, circle names, reactions and call media are encrypted on device.
2. **Collect almost nothing.** No phone number, email optional, no contact upload, no analytics, short logs.
3. **Calm, not compulsive.** Chronological feed, no engagement tricks, no public like counts by default.
4. **Safe by default.** Disappearing messages on, read receipts off, profile details visible only to connections (strangers can only find you by your exact @handle).
5. **Prove it.** Open source code, a live data page, one-tap export and verifiable safety numbers.
6. **Everyone, everywhere.** WCAG 2.2 AA, right-to-left layouts, low-bandwidth friendly, native apps.

When convenience and protection disagree, protection is the default.

## Architecture

| Part | What it is |
|---|---|
| `apps/web` | The app: Next.js 16 (App Router), React 19, a token-based design system (`src/styles/v2`), i18n catalogues (`src/i18n/messages`). Strict nonce-based CSP, no third-party scripts, fonts or runtime requests |
| `apps/mobile` | Capacitor 8 shell for iOS and Android, with native passkeys, secure key storage, biometrics and encrypted native push |
| `packages/crypto` | All cryptography: key hierarchy, envelopes, audience keys, safety numbers, built on the audited `@noble/*` libraries |
| `supabase` | Postgres schema with row-level security on every table, pgTAP tests, and the data map that classifies every column |

The server stores ciphertext and the minimum metadata needed to deliver it. Design documents:

- [Product brief](docs/v2/00-brief.md): what Kithwall is, who it is for, principles and phases
- [Accounts and keys](docs/v2/01-accounts.md): passkey-first sign-up, key wrapping, recovery
- [Safety centre](docs/v2/03-safety.md) · [Transparency and verification](docs/v2/03-transparency.md)
- [Calls](docs/v2/04-calls.md): end-to-end encrypted voice and video
- [Native apps](docs/v2/05-native.md): Capacitor, native push, builds and store distribution
- [Original specification](docs/03-spec.md) (threat model, data model) and [developer guide](docs/dev-guide.md)
- [Legal drafts](docs/legal/README.md)

## Running it locally

You need Node 22+ (24 recommended), npm, Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```sh
npm install
supabase start                    # local database, auth, storage and realtime (ports 643xx, see supabase/config.toml)
cp apps/web/.env.example apps/web/.env.local   # fill in the URL and keys printed by `supabase start`
npm run dev                       # http://localhost:3000
```

Tests:

```sh
supabase test db                                  # row-level security and data-map tests (pgTAP)
npx vitest run --root packages/crypto             # crypto
cd apps/web && npx vitest run                     # web unit tests (i18n catalogues, parsers, …)
cd apps/web && npx next typegen && npx tsc --noEmit -p . && npx eslint src
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change.

## Deploying

- Web: Vercel (Root Directory `apps/web`) and a Supabase project. Follow [docs/deploy.md](docs/deploy.md)
  for the Supabase Auth settings, environment variables, cron jobs and push keys.
- Native apps: [docs/v2/05-native.md](docs/v2/05-native.md) (signing, push providers, store listings, APK).

## Running your own instance

You are welcome to run your own Kithwall. Under the AGPL, if you modify it and let people use it over a
network, you must offer those users the source code of your modified version. The app already links to
the source of the running version (footer and Settings → Help & about); point that link at your own
repository if you fork it.

## Licence

Copyright (C) 2026 the Kithwall contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License as published by the Free Software Foundation, version 3 of the License
(`AGPL-3.0-only`). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE).

## Security

Please don't report vulnerabilities in public issues. Use a private
[GitHub security advisory](https://github.com/443abdul/kithwall/security/advisories/new) or email
**security@kithwall.com**. Details are in [SECURITY.md](SECURITY.md).

## Community

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Kithwall doesn't
take donations yet; see [/donate](https://kithwall.com/donate) for other ways to help.
