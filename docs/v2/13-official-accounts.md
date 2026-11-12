# Kithwall 2: official, automated accounts

Status: implemented · 2026-11-12 · migration `supabase/migrations/20261113000100_official_accounts.sql` ·
code `apps/web/src/lib/official`, `apps/web/src/app/api/cron/official` · tests
`apps/web/src/lib/official/official.test.ts`, `supabase/tests/official_accounts.test.sql`

Explore is empty for someone who has just joined and follows nobody. A few accounts run by Kithwall itself
fill it with things worth reading: a featured article and a picture of the day, what happened on this day,
space pictures, science and world news, and educational videos. They are **labelled as automated everywhere**,
they post only what their sources allow, and every post names its source and links to the original.

This is the opposite of fake users. There are no invented people, no invented likes or followers, and
nothing is copied that its publisher did not offer for this use.

## 1. The accounts

| Handle | Name | Posts |
|---|---|---|
| `@kithwall.learn` | Kithwall Learn | Wikipedia: featured article, picture of the day, on this day · TED-Ed, CrashCourse, Khan Academy videos |
| `@kithwall.science` | Kithwall Science | NASA image of the day and news · Our World in Data · Kurzgesagt, Veritasium videos |
| `@kithwall.news` | Kithwall News | UN News, World Health Organization (BBC News and Dawn: off until the operator switches them on) |
| `@kithwall.urdu` | Kithwall اردو | UN News in Urdu (BBC Urdu: off until the operator switches it on) |

An account is created the first time it has something to post. Each posts at most 8 times a day.

**What makes them trustworthy**

- **Marked.** `public.automated_accounts()` lists them for everyone (with or without an account) and the app
  shows an **Automated** badge next to their name on posts, on their profile and in search. Only the service
  role can add to that list.
- **Not imitable.** No one can register or rename to a handle that starts with `kithwall` (database trigger
  `profiles_official_prefix`, and the sign-up form says the handle is reserved).
- **Ordinary Public posts.** Signed with the account's own key, labelled Public, reportable, hidden after
  enough reports and removable by moderators exactly like any other public post (`10-follow-public.md` §7).
  The job signs in *as the account* and inserts through the same database rules as a person; it never writes
  a post with the secret key.
- **Follow only.** They cannot be sent connection requests or mentioned (nobody would answer). The profile
  offers Follow and says what the account is.
- **Nothing private.** The job only writes public posts. It reads nothing about people, and nothing is
  recorded about who reads or follows what beyond the follow itself.

## 2. What may be shown

Each source has `terms`, and the composer (`lib/official/compose.ts`) shows no more than they allow:

| `terms` | Shown | Sources |
|---|---|---|
| `public-domain` | title, summary and picture, credited | NASA |
| `cc` | title and an excerpt with the licence named; a picture only when **that file's own licence** is public domain, CC0, CC BY or CC BY-SA, credited to its author | Wikipedia, Wikimedia Commons, Our World in Data |
| `summary` | the headline and the short summary the publisher puts in its own feed, and the link | UN News, WHO |
| `headline` | the headline and the link, nothing else | BBC, Dawn (off by default) |
| `embed` | the title; the video plays in the publisher's own player after the reader presses play; no thumbnail is copied | YouTube channels |

Rules that hold for every source:

- Feeds are untrusted text. Markup is removed and entities decoded (`lib/official/feeds.ts`); what remains is
  shown as plain text. Links must be `https`.
- Pictures are fetched only from the publisher's own hosts (`nasa.gov`, `wikimedia.org`), also after a
  redirect, at most 6 MB, and only if the file itself is a JPEG, PNG or WebP of sane size
  (`lib/official/image.ts`). They are stored like every picture in Kithwall: encrypted, with the key in the
  public post.
- News older than three days is not posted, so switching a source on does not post its backlog.
- Nothing is posted twice (`official_items`, a hash of each item's address).
- A source's address is fixed by a migration. The admin screen can switch a source on or off, not point it
  somewhere else, so the job cannot be made to fetch an arbitrary address.

Featured-article thumbnails from Wikipedia are **not** used: the English Wikipedia holds non-free pictures
under fair use, and the feed does not say which are free.

Adding a source is a migration that inserts a row into `official_sources` (and, for a new kind of feed, a
composer). Check the publisher's terms first and pick the narrowest `terms` that fits.

## 3. The job

`GET /api/cron/official` (Vercel Cron, daily at 03:10 UTC, `Authorization: Bearer $CRON_SECRET`), or
Admin → Operator settings → Official accounts → **Post now** (`POST /api/official/run`, admins only).

1. Stop unless `KITHWALL_OFFICIAL_SEED` is set and the operator's switch `official_accounts_enabled` is on.
2. Read every enabled source at once (9 s each); drop what was posted before and what is stale.
3. For each account: sources take turns, each gives at most its `per_day`, the account at most 8. Open the
   account's keys (below), sign in as the account, and for each item: claim it in `official_items`, fetch and
   encrypt its picture if it may have one, sign the post, insert it. The first post goes out now and the rest
   are spread over the next 20 hours with `publish_at` (the same scheduling people use), so the accounts are
   alive all day although the job runs once.
4. A post that fails gives its claim back and removes its picture; the next run tries again. The job stops
   starting new work after 45 s; what is left is picked up next time.
5. Housekeeping: notifications addressed to automated accounts are deleted (nobody reads them); claims older
   than 400 days are forgotten.

Each source row records when it was last read, when it last posted, and the last error; the admin screen
shows them.

## 4. Keys

An automated account has the same kind of keys as a person. They are generated by the job, and the account
key is wrapped under `HKDF-SHA-256(KITHWALL_OFFICIAL_SEED, salt "kithwall/v1/official", info "kek/<slug>")`
in the place a passphrase-derived key would go (`key_bundles.bundle.amkByPassword`). So:

- only a process that holds the seed can sign as these accounts;
- nobody can sign in to them: the auth user has a random password nobody knows and no passkey;
- the public keys are in the key-transparency log like everyone's;
- **if the seed is lost or changed, the existing accounts can no longer post** (the job reports "does not
  open this account"). Keep a copy of the seed with the other keys outside the repository. Recovering means
  deleting the account in Admin and letting the job create a fresh one.

## 5. Operator

1. `supabase db push` (one migration).
2. Set **`KITHWALL_OFFICIAL_SEED`** in Vercel (Production) to a long random value, for example the output of
   `openssl rand -base64 48`, and keep a copy offline. Until it is set, the job does nothing. `CRON_SECRET`
   must be set already (the other cron jobs use it).
3. Admin → Operator settings → **Official accounts**: the main switch, each source's switch, when each last
   ran, and "Post now". Review the sources that are off by default before switching them on; they are
   publishers that offer a feed but whose terms are about personal use, so only the headline and link are
   shown.
4. To stop everything: switch "Official accounts" off (posts already scheduled for later today still go out;
   remove them from the account's profile as a moderator if needed), or remove the seed.

## 6. What the server now holds

Three small tables, none about people: which accounts are automated (public), the list of sources and when
each ran, and hashes of the items already posted. The "What Kithwall knows" page lists them. The posts
themselves are Public posts and are covered by `10-follow-public.md` §8.

## 7. Not in this round

- **Reels from the automated accounts.** A reel is an uploaded video with a poster frame; making one on the
  server needs a video toolchain the site does not have, and suitable free-licence short vertical videos are
  rare. For now videos are YouTube embeds in Explore.
- A picture and bio on the automated accounts' profiles (follow-enabled accounts have a public name only).
- Running more often than daily (posts are scheduled across the day instead).
