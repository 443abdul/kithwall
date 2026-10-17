# Kithwall

*Your 2010 social network, sealed.*

Kithwall is a faithful recreation of 2010-era social networking — the Wall, News Feed, photo
albums with tags, pokes, chat, groups and events — where everything you share with friends is
**end-to-end encrypted**. No ads, no tracking, no algorithmic feed you didn't ask for.

## Status
Planning. Read the documents in order:

1. [Foundation](docs/01-foundation.md) — vision, audience, principles, stack
2. [Scope](docs/02-scope.md) — every 2010 feature, what changes for privacy, releases
3. [Specification](docs/03-spec.md) — threat model, cryptography, data model, security, testing, deployment

The visual reference is [`reference/theassbook-2010.html`](reference/theassbook-2010.html)
(open it in a browser).

## Deployment (once code lands)
Vercel → import this repository → set **Root Directory** to `apps/web` → add the environment
variables listed in [the spec](docs/03-spec.md#9-deployment).
