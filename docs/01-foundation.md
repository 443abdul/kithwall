# Kithwall — 01 · Foundation

> **kith** */kɪθ/* (n., Old English *cȳþþ*): the people you know — your friends, neighbours and
> acquaintances, as in "kith and kin". **Kithwall**: a wall for the people you actually know.

## 1. What we are building

Kithwall is the 2010-era social network people remember fondly — the Wall, the News Feed, photo
albums with tags, pokes, chat, events, groups, "What's on your mind?" — rebuilt as a modern,
multi-user web product whose operator **cannot read what its users share**.

The visual and functional reference is the 2010 replica
([`reference/theassbook-2010.html`](../reference/theassbook-2010.html)). Kithwall must look and
behave like it on desktop, adapt cleanly to phones and tablets, and work for real people with
real accounts.

## 2. Who it is for

| Audience | What they want | What they hate about today's social media |
|---|---|---|
| **Friend groups & families** (primary) | A private place to share photos, plans and updates with 20–300 people they actually know | Ads, algorithms, strangers, data harvesting |
| **2010 nostalgics** (millennials, ~28–45) | The cozy, chronological, friends-only feel of 2010 | Feeds full of creators and brands |
| **Privacy-conscious people** | Messaging-app-grade encryption for their whole social life, not just chats | "Private" settings that only hide things from other users, not from the company |

**Positioning line:** *Your 2010 social network, sealed.* Everything you share with friends is
end-to-end encrypted. No ads. No tracking. No algorithmic feed you didn't ask for.

## 3. Product principles

1. **Faithful, not frozen.** Reproduce the 2010 look, layout and features. Change things only where
   2010 behaviour conflicts with privacy, security or accessibility, and document each change.
2. **The server is untrusted for content.** Posts, comments, photos, messages, profile details,
   tags, check-ins and polls are encrypted on the user's device. The server stores ciphertext and
   the minimum metadata needed to route it.
3. **Honest about limits.** Where something cannot be hidden (who is friends with whom, when you
   post, how big things are), say so plainly in the product and in the threat model.
4. **No surveillance business model.** No ads, no third-party scripts, no analytics SDKs, no data
   sales, no tracking pixels. Ever.
5. **Users own their data.** Full export (decrypted, on-device) and real deletion at any time.
6. **Secure by default.** Least privilege everywhere: deny-by-default database policies, strict
   browser security headers, audited cryptography libraries only.

## 4. Naming & domains (checked 2026-10-17)

| Asset | Status |
|---|---|
| kithwall.com | Available — $11.25/yr (purchase is the owner's decision) |
| kithwall.app · .social · .org · .net · .io | Available |
| GitHub `443abdul/kithwall` | Created (private) |

Rejected candidates: kinfold, closefolk (.com taken), hushbook, sealbook, hearthbook, kithly (taken).

## 5. Technical foundation

| Layer | Choice | Why |
|---|---|---|
| Web app | **Next.js 16 (App Router) + React 19 + TypeScript (strict)** | Vercel-native, server components for the static shell, mature ecosystem |
| Styling | **CSS Modules + design tokens** | Pixel-exact 2010 styling is easier with hand-written CSS than utility classes |
| Data | **Supabase**: Postgres 17 with Row-Level Security, Auth, Storage, Realtime | Mature hosted Postgres with built-in auth and realtime; RLS gives defence in depth |
| Crypto | **@noble/curves, @noble/ciphers, @noble/hashes, @scure/bip39** (audited, pure TS), **hash-wasm** (Argon2id), **shamir-secret-sharing** (audited) | No native code, small, independently audited |
| Client data | TanStack Query, IndexedDB (encrypted local cache), Web Worker for crypto | Keeps the UI responsive while decrypting |
| Tests | Vitest (unit + crypto test vectors), Playwright (end-to-end, multi-user), pgTAP (RLS policies) | Each layer is tested where it lives |
| Delivery | GitHub (private) → Vercel; Supabase CLI migrations; GitHub Actions CI | Matches the requested deployment path |

### Environment on hand
Node 24.20, npm 11.19, git 2.55, GitHub CLI (logged in as **443abdul**), Supabase CLI 2.121,
Deno, Bun. All present — no installs needed.

## 6. Infrastructure decision (pending)

The existing Supabase project **17g** already hosts a clinical-trials data app (studies,
subjects, randomizations, audit log; ~6,000 rows). A Supabase project has a single shared
`auth.users` table, and 17g's policies allow any signed-in user to insert studies, subjects and
queries. Putting a public social sign-up there would let strangers create accounts inside a
clinical system.

**Recommendation:** a dedicated Supabase project for Kithwall (**$10/month** quoted for this
organisation). No database work happens until the owner approves the spec and this choice.

## 7. Repository layout

```
kithwall/
├─ apps/web/               Next.js app (deployed by Vercel; set Root Directory = apps/web)
├─ packages/crypto/        All cryptography: key hierarchy, envelopes, recovery, tests
├─ supabase/
│  ├─ migrations/          Schema + RLS, applied with the Supabase CLI
│  └─ tests/               pgTAP policy tests
├─ reference/              The 2010 visual reference
└─ docs/                   01-foundation · 02-scope · 03-spec
```
