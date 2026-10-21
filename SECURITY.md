# Security policy

Kithwall protects people, some of them at real risk, so we take reports seriously and are grateful for them.

## Reporting a vulnerability

**Please report privately. Never open a public issue, discussion or pull request for a vulnerability.**

- Preferred: a private [GitHub security advisory](https://github.com/443abdul/kithwall/security/advisories/new)
  ("Report a vulnerability" on the repository's Security tab).
- Or email **security@kithwall.com**.

Please include what you found, the steps to reproduce it, the impact you expect, and the version or commit
(the app links to its source commit in the footer and in Settings → Help & about). A proof of concept helps.

What to expect:

- We acknowledge reports within **3 working days** and keep you updated at least weekly.
- We aim to fix critical issues within **14 days** and others within **90 days**, and we coordinate the
  disclosure date with you.
- We credit you in the advisory unless you prefer to stay anonymous.

## Scope

In scope:

- The web app and API routes in `apps/web` (kithwall.com), including its Content Security Policy.
- The iOS and Android apps in `apps/mobile`.
- The cryptography in `packages/crypto` and how the app uses it (key handling, envelopes, audience keys,
  safety numbers, recovery).
- The database schema, row-level security and functions in `supabase/`.
- Anything that lets someone read content they shouldn't, learn metadata we promise not to keep, impersonate
  a person, or bypass the Safety centre's protections.

Out of scope:

- Attacks that need a compromised device, malicious browser extension, or physical access to an unlocked
  device (we still want to hear about cheap mitigations).
- Social engineering of Kithwall users or staff, and physical attacks.
- Denial of service by volume, and rate-limit tuning without a concrete abuse path.
- Missing best-practice headers or settings with no demonstrated impact.
- Vulnerabilities in third-party services (Vercel, Supabase, Cloudflare, push providers): report those to
  the vendor, but tell us if Kithwall's configuration makes it worse.
- Known limits we document ourselves, such as metadata the server must see and the lack of forward secrecy
  for posts (see the privacy policy, "Honest limits").

## Rules of engagement

- Only test against accounts you own, or a local instance (`supabase start` + `npm run dev`). Running your
  own instance is the best way to test.
- Don't access, modify or delete other people's data, and stop as soon as you see data that isn't yours.
- Don't degrade the service for others (no load testing, spam or automated scanning of kithwall.com).
- Give us a reasonable time to fix the issue before disclosing it.

We won't take legal action against good-faith research that follows these rules.

## Rewards

There is **no bug bounty yet**. Kithwall is free and doesn't take donations yet, so we can only offer
thanks and public credit. If that changes, it will be announced here.

## Supported versions

Only the latest deployed version of kithwall.com and the latest app store releases receive security fixes.
