# Kithwall 2: follow, Followers posts, Public posts, Explore

Status: implemented · 2026-11-11 · migration `supabase/migrations/20261112000100_follow_public.sql` ·
tests `supabase/tests/follow_public.test.sql`, `apps/web/src/lib/follow`, `apps/web/src/lib/social/hiddenWords.test.ts`,
`apps/web/src/lib/keys/authority.test.ts`

Kithwall was connections-only: you share with people you approved, and nobody else can read a word. The owner
wants it to also work for the general public **without giving up that promise**. The rule that makes both
possible:

> Nothing changes for anyone who does not turn "Let people follow me" on. For those who do, every post still
> says exactly who can read it, and the only thing the server can ever read is what its author explicitly
> marked **Public**.

## 1. What a person can choose

| Audience of a post | Who reads it | Encrypted? | Who can pick it |
|---|---|---|---|
| Connections, Close friends, a circle, Only me | as before | end-to-end | everyone |
| **Followers** | everyone who follows me, and my connections | **end-to-end** (key handed out by my own devices) | accounts with follow on |
| **Public** | anyone, also without an account | **no**: signed by me, readable by anyone including Kithwall | accounts with follow on, older than 24 h |

Nothing is widened silently: the default audience stays what it was (Connections), and Followers / Public
appear in the audience picker only after follow was turned on. Before the first public post a one-time sheet
says: *"Anyone can see this, including people without an account. It is not end-to-end encrypted."* Every
public post carries a **Public** label wherever it is shown, and the composer repeats the sentence while
Public is selected.

Settings → **Following and public posts** (`components/settings/FollowSettings.tsx`):

| Switch | Default | Stored |
|---|---|---|
| Let people follow me (needs a public name) | off | `profiles.follow_enabled`, `profiles.display_name_public` |
| Let search engines show my public posts | off | `privacy_prefs.index_public` |
| Show who I follow to my connections | on | `privacy_prefs.show_following` |
| Who can comment on my posts / who can mention me | everyone | `privacy_prefs.comment_policy`, `mention_policy` |
| Hidden words | none | encrypted vault (`hiddenWords`), never on the server |
| Restricted accounts | none | `public.restrictions` |

Turning follow **off** again is a pause, not a deletion: nobody new can follow, people who only follow stop
receiving anything (the database refuses them), and every public post of the account leaves public view
(Explore, its link, the profile) until follow is turned on again. Connections are never affected.

## 2. Follow

`public.follows (follower_id, followee_id, created_at)`. Following is instant: no request, no approval. Anyone
signed in whom the account has not blocked may follow an account that has follow on (RLS `follow accounts
that allow it`; 200 follows a day, `kw.rate_limit('follow')`). The followee can remove a follower; either side
can block, which removes follows in both directions (`kw.on_block`). **Connections count as followers** without
a row (`kw.is_follower`), so they see Followers posts too. The profile shows Follow / Following and the
follower count (followers plus connections, `public.follow_info`).

Who can see a follow: the follower, the followee, and the follower's connections unless they switched
"Show who I follow to my connections" off. Nobody else (tested), and never people without an account.

## 3. Followers posts stay end-to-end encrypted

Each follow-enabled account gets one audience of kind `followers`, created by the database the moment follow
is switched on. It reuses the audience-key machinery of the `friends` audience unchanged
(`lib/keys/keyring.ts`, `lib/keys/authority.ts`, security review K1/K2/R-K-1):

- **Only the owner's devices mint and hand out its key** (`kw.is_key_authority`, client `isKeyAuthority`). The
  key of each epoch has a record signed by the owner; a device adopts a key only if it matches that record,
  whoever relays it. A follower cannot hand out a key of their own (unit-tested: `followers audience`).
- The key is sealed to each follower with the hybrid X25519 + ML-KEM-768 box, by the owner's device, when it
  learns of the follower: at once if a device is open (Realtime `follows` insert), otherwise the next time
  one comes online (`pending_key_deliveries` now also lists followers and connections for this audience).
- So **a new follower can read nothing until one of the owner's devices has been online**. The app says so
  where it matters: *"You'll see {name}'s posts once their device has been online"* on the profile and right
  after following, and each unreadable post shows the usual "Waiting for a key from {name}'s device".
- **Removing or blocking a follower** (or ending a connection with someone who does not also follow) rotates
  the key (`keyring.afterFollowerRemoved` → `rotate`): the next epoch's key goes to the remaining followers
  only, and new posts use it. As everywhere in Kithwall, what the removed person already received stays
  readable to them. Someone who unfollows by themselves is simply refused new posts by the database; no
  rotation (it would cost a new key for every remaining follower each time anyone leaves).

What is different from the friends audience, and why:

- **Nobody vouches for a follower.** For circles a device seals the key only to members with a signed
  addition. A follow needs nobody's approval, so there is no signature that could mean anything (a signature
  by the follower proves nothing the server could not arrange with an account of its own). Membership is
  whatever the server lists, as for `friends` (`implicitMembers`).
- **Followers are not pinned.** Pinning every stranger who follows would grow the encrypted vault without
  bound. The owner's device seals to the follower's published key without a pin or a key-log lookup
  (`sealGate(..., { pinNew: false })`); anyone the device already knows is held to their pin as usual.
  Followers do pin the accounts they follow, so they notice if the key of someone they follow is swapped.

**Honest limit.** "Followers" means *anyone who chooses to follow*, and that includes the operator through an
ordinary account. The server lists the followers; a dishonest server could add one the owner does not see.
The server still cannot read Followers posts by itself (it never holds the key), cannot forge them, and
cannot make a device adopt a key the owner did not sign. For anything private, the audiences to use remain
Connections, Close friends and circles. The app's wording for this audience is "followers", never "private".

## 4. Public posts

Built on the existing `posts.is_public` / signed public envelope (`packages/crypto` `sealEnvelope` with
`audience: 'public'`: canonical JSON body plus the author's Ed25519 signature, no encryption).

- **Who may post:** only on one's own profile, only with follow on, only when the account is older than
  `app_settings.public_post_min_age_hours` (24) and the operator's `public_posts_enabled` is on, at most 20 a
  day (`kw.can_post`, `kw.may_post_public`, `kw.posts_guard`). The older `public_audience_enabled` switch
  (open circles, public events) is separate and stays off.
- **Who may read:** everyone signed in who is not blocked (RLS `kw.can_read_post`), and people without an
  account through three functions that return only live public posts: `explore_posts`, `public_post`,
  `public_comments`. Each row carries the author's handle, public name and signing key, and readers verify
  the signature on their device before showing anything.
- **Photos and videos** stay the encrypted objects they always were, in the same private bucket; a public
  post's payload carries their file keys in the open, so whoever may fetch the object can open it. A storage
  policy lets people without an account fetch exactly the files linked to a live public post
  (`public.public_media_readable`). Nothing is re-uploaded in the clear and no second storage path exists.
- **Comments and reactions on a public post are public too** (signed envelopes, like the post). The comment
  box says so.
- **Shareable link:** `/p/<post id>` opens the post and its comments read-only without an account
  (`components/public/PublicPostScreen.tsx`). `noindex` unless the author turned on "Let search engines show
  my public posts"; the page asks the same database function for that with the app's public key.
- **Signature trust.** Signed in, a post is checked against the key this device already trusts for its
  author where it has one. Without an account (or for a stranger in Explore) it is checked against the key
  that came with the post: that proves the post was not altered on the way, not that the server tells the
  truth about whose key it is. The public key-transparency log (`09-key-transparency.md`) covers every
  published key and is checked for the accounts a person follows.

## 5. Explore

A new main destination (`/explore`, `components/explore`).

- **Posts**: public posts from everyone, *Popular* or *Newest*. Popular is
  `(1 + likes + 2 × comments) / (age in hours + 2)^1.5` over the last 14 days, computed by `explore_posts`
  from **public signals of public posts only**. It is the same list for everyone (minus accounts the reader
  blocked or is blocked by). The server stores nothing about who looked at what: the functions are read-only
  and no table records views, opens, dwell time or searches (tested).
- **People → search** by name or @handle (`search_accounts`): returns **only follow-enabled accounts**. The
  search text is sent to the server for that one query and is not stored. Finding anyone else still needs
  their exact @handle (Connections).
- **People → Suggested accounts**, computed **on the device**: the server hands over one plain list, "which
  follow-enabled accounts my connections follow" (`connections_following`, only connections who left
  "Show who I follow to my connections" on); counting, ranking and filtering happen in
  `lib/follow/suggest.ts`, and dismissed suggestions live in the encrypted vault. The server learns nothing
  it did not already hold (it stores both graphs) and is not told which suggestions were shown, opened or
  dismissed.

**Seam for further public feeds** (e.g. short videos):

- data: `fetchPublicPosts({ sort, kinds, authorId, limit }, cursor)` and `publicPostsKey` in
  `lib/public/posts.ts` (SQL: `explore_posts(p_sort, p_kinds, p_before, p_offset, p_limit, p_author)`;
  `kinds: ['video']` is a video-only feed). Rows are `PublicPostRow`; open them with `openPublicPost(row)`.
- UI: `usePublicPosts(query)` and `<PublicFeed query=… label=… />` in `components/explore/PublicFeed.tsx`,
  `<PublicPostCard row=… />` for one post.
- navigation: add an entry to `EXPLORE_TABS` in `components/explore/tabs.tsx`; a new main destination is one
  more entry in `NAV` (`components/shell/nav.ts`; the tab bar lays out any number of entries).

## 6. Comment controls and filters

- **Who can comment**: everyone who can see the post / followers (and connections) / connections / nobody;
  per account, and per post (`posts.comment_policy`, chosen in the composer's options or later from the
  post's menu; not an edit). Enforced by the database on insert (`kw.may_comment`); the app asks
  `comment_gates` so it can show "The author has limited who can comment" instead of a box. Circle and event
  posts are not affected.
- **Who can mention me**: same four choices (`kw.may_mention`). Accounts that never turned follow on keep
  today's rule whatever the setting says: only people they are connected to or share a circle with.
- **The author removes comments** on their posts (existing rule, now with strangers in mind).
- **Restrict** (`public.restrictions`): comments a restricted person writes on my posts are shown only to
  them and to me (RLS `kw.comment_shown`, also left out of public pages and counts). They are not told.
- **Hidden words**: a personal list in the encrypted vault, applied on the device to posts and comments
  (`lib/social/hiddenWords.ts`; whole words and phrases, any script). Matches fold away for me only, with a
  "Show" link. The server never learns the list.
- On Followers and Public posts the people commenting may be strangers to the reader, whose profiles they
  cannot list. `comment_authors` returns just their handle, public name and signing key for that thread;
  they are not added to the reader's people directory (and so not pinned).

## 7. Safety for public content

- Public posts and public comments are reportable through the existing flow. The report snapshots the stored
  item; for public content that is the readable text, and `/mod` shows it with the author's signature
  checked (`components/mod/verify.ts`).
- **A public post is hidden automatically once `public_report_hide_threshold` (5) different accounts
  reported it** (`kw.reports_public_hide`), from everyone but its author (who sees a notice) and moderators,
  until a moderator removes it or decides it may stay (`mod_restore_public_post`: shown again, open reports
  closed, never auto-hidden again unless edited). Encrypted posts are never hidden by counts.
- Rate limits: 200 follows a day, 20 public posts a day, 300 searches an hour, on top of the existing limits
  for posts, comments, reports and notifications.
- A block cuts follow and visibility both ways (posts, Explore, search, comments).
- Accounts younger than 24 hours cannot post publicly.

## 8. What the server now sees, and what it still cannot

New, readable by the server:

| | |
|---|---|
| Whether an account lets people follow it, and its public name | `profiles.follow_enabled`, `display_name_public` |
| The follow graph: who follows whom, since when | `follows` |
| Who restricted whom | `restrictions` |
| The four per-account switches | `privacy_prefs` |
| Per post: who can comment; for a public post, hidden / reviewed times | `posts.comment_policy`, `public_hidden_at`, `public_reviewed_at` |
| **Everything in a Public post**: text, links, the keys of its photos and videos, its comments and reactions | `posts.envelope` / `comments.envelope` (signed, not encrypted) |
| Search text, for the duration of one query | not stored |

Still not visible to the server: the content of every post that is not Public (Followers posts included),
profiles beyond the public name, hidden words, saved posts, muted people, dismissed suggestions, which
suggestions or Explore posts a person looked at, and all messages and calls. The "What Kithwall knows"
page lists the new tables and columns (data map rows in the migration), and the export includes who I
follow, my followers, the people I restricted, my switches and my hidden words.

Threats considered:

| Threat | Outcome |
|---|---|
| Server reads Followers posts | No: it never holds the audience key. It can follow through an account like anyone else (§3). |
| Server or a follower plants a key for the followers audience | Rejected: only keys matching the owner's signed epoch record are adopted. |
| Server alters a public post | Detected: the signature fails ("couldn't be verified"), signed in or out. |
| Server shows a signed-out reader a post under the wrong author | Not preventable without an account (§4); signed-in readers check against pinned or logged keys. |
| Removed or blocked follower keeps reading | New posts use a rotated key they never get; the database refuses them the rows as well. |
| Profiling what people read | Nothing is recorded; ranking is global; suggestions are computed on the device. |
| Harassment in comments by strangers | Who-can-comment, remove, restrict, hidden words, block, report. |
| Spam accounts posting publicly | 24 h account age, 20 a day, auto-hide after reports, moderators see plain text. |
| A public post indexed against the author's wish | `noindex` unless the author opts in. Links can still be shared by anyone who has them. |

## 9. Not in this round

- A public picture and bio for follow-enabled accounts (followers see the public name and initials; the
  rest of a profile stays encrypted for connections).
- Reposting to Followers or Public from the share sheet (reposts go to connections and circles as before).
- Public profile pages without an account (a public post's link works; the profile needs sign-in).
- Batched key delivery: after a rotation the owner's device seals one key per follower (2,000 per pass,
  repeated until done). Fine for thousands of followers; very large accounts will want a key tree.
- Notifications still load each actor into the people directory (and pin them); very large accounts will
  want a lighter path, as §6 does for comments.

## 10. Production

1. `supabase db push` (one migration, `20261112000100_follow_public.sql`; no data rewrite).
2. No new environment variables. `/p/<id>` reads `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, which are already set.
3. Operator settings (Admin → Operator settings): *Public posts* (on), *Hide a public post after reports from
   this many accounts* (5), *Hours before a new account can post publicly* (24).
4. Update the Privacy Policy and the Community Standards for public posts and the follow graph before
   announcing the feature, and translate the new strings (`i18n/messages/en.json`, keys `follow.*`,
   `explore.*`, `comments.*`, `hidden.*`, `restrict.*`).
