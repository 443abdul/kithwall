# Kithwall — 03 · Technical Specification

Status: **Draft for owner review** · Applies to releases R0–R1 in full and R2–R3 in outline.
Read with [01-foundation](01-foundation.md) and [02-scope](02-scope.md).

---

## 1. Architecture

```
 Browser (Next.js app, PWA)                                 Vercel
 ┌──────────────────────────────────────────────┐          ┌──────────────────────────────┐
 │ UI (React, CSS Modules, 2010 design tokens)  │  HTML/JS │ Next.js: static shell, a few │
 │ TanStack Query  ◄──►  Crypto Web Worker      │◄─────────│ route handlers (auth hook,   │
 │   (plaintext lives  (keys in memory only;    │          │ account deletion, link-      │
 │    only in here)     @noble / hash-wasm)     │          │ preview proxy). No content.  │
 │ IndexedDB cache (encrypted with device key)  │          └──────────────────────────────┘
 └───────────────┬──────────────────────────────┘
                 │ HTTPS + WSS (JWT)   ciphertext + routing metadata only
 ┌───────────────▼──────────────────────────────────────────────────────────────────────┐
 │ Supabase: Auth · Postgres 17 + RLS · Storage (encrypted blobs) · Realtime             │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

- All encryption and decryption happen in the browser, inside a dedicated Web Worker. Plaintext
  never goes to Vercel or Supabase (exception: content the author marks **Public**).
- The browser talks to Supabase directly with the publishable key and the user's JWT; every table
  is protected by Row-Level Security (RLS). RLS is defence in depth — the main protection for
  content is that the server only holds ciphertext.
- Vercel route handlers exist only for things a browser can't do safely: the sign-up anti-abuse
  hook, account deletion (needs the secret key), and fetching link previews without leaking
  users' IP addresses to third-party sites.

---

## 2. Threat model

### We protect against
| Adversary | Protection |
|---|---|
| Kithwall operator, a hosting employee, or anyone who obtains a database/storage dump | All non-public content is end-to-end encrypted; private keys are stored only wrapped by keys the server never sees |
| Other users who aren't in a post's audience | Encryption (they don't hold the key) **and** RLS (they can't fetch the row) |
| Ex-friends after unfriending | Audience key rotation: they can't decrypt anything posted afterwards; RLS stops them fetching older posts |
| Someone who takes over your email account | Email alone gives no keys; destructive actions require proof of your identity key (§3.9); recovery requests notify you and wait 24 h |
| Server swapping or replaying ciphertexts | Every envelope is bound to its row (author, object id, type) with authenticated data and signed by the author |
| Server substituting someone's public key (man-in-the-middle) | Key changes are signed by the previous key and announced in-app; optional safety-number verification (R3) |
| Credential stuffing, spam sign-ups | Argon2id-stretched passwords, Supabase auth rate limits, proof-of-work captcha, per-action rate limits, MFA |
| Cross-site scripting / injection | Strict nonce-based Content-Security-Policy (Trusted Types deferred, §12), React escaping, no inline HTML from users, parameterised queries |

### We do **not** fully protect against (stated in-product)
- **Metadata.** The server can see who is friends with whom, who messages whom, when, and roughly
  how big things are; group and event membership; likes on non-public items (as counts and rows).
- **A malicious build of the web app.** On the web, the server delivers the code that holds the
  keys. Mitigations: open source, published build hashes per release, no third-party scripts;
  later a verifier extension. This is the known limit of any browser-based E2EE product.
- **Compromised devices** (malware, a browser extension with page access).
- **Friends who screenshot or copy** what you share with them.
- **Forward secrecy** in v1. Someone who later steals your account master key can decrypt your
  past content. Forward-secret messaging (MLS, RFC 9420) is planned for R3.

---

## 3. Cryptography

All primitives come from audited libraries. No custom ciphers.

| Purpose | Primitive | Library |
|---|---|---|
| Symmetric encryption | XChaCha20-Poly1305 (24-byte random nonces) | @noble/ciphers |
| Key agreement | X25519 | @noble/curves |
| Signatures | Ed25519 | @noble/curves |
| Key derivation | HKDF-SHA-256 | @noble/hashes |
| Password stretching | Argon2id — 64 MiB, 3 passes, 1 lane, 32-byte output | hash-wasm |
| Recovery phrase | BIP-39 English, 24 words = 256 bits | @scure/bip39 |
| Secret sharing | Shamir over GF(2⁸) | shamir-secret-sharing (Privy; audited by Cure53 & Zellic) |
| Randomness | `crypto.getRandomValues` | WebCrypto |

Byte strings are stored as `bytea` and sent base64url-encoded. All structures carry a version
number so algorithms can be upgraded.

### 3.1 Key hierarchy

```
 password ──Argon2id(salt = H("kithwall/v1/salt" ‖ email))──► stretched (32 B)
                                         │
                       ┌─────────HKDF────┴─────HKDF────────┐
                       ▼                                    ▼
               authKey (→ Supabase password)        passwordKEK (never leaves device)
                                                            │ wraps
 recovery phrase (24 words = RK) ──HKDF──► recoveryKEK ─────┤ wraps
                                                            ▼
                                     Account Master Key  AMK (32 B random)
                                                            │ wraps / derives
           ┌───────────────────────────┬────────────────────┼───────────────────────┐
           ▼                           ▼                    ▼                       ▼
  identity signing key        identity agreement key    vaultKey               cacheKey
  Ed25519 (IK_sig)            X25519 (IK_kx)            (private settings,     (local IndexedDB
                                                         game state, list names) cache)
           │                           │
           │ signs everything          │ receives sealed keys:
           ▼                           ▼
                     audience keys (friends / lists / groups / events, versioned by epoch)
                     conversation keys (messages & chat)
                                       │ wrap
                                       ▼
                     per-object content keys (each post, album, photo file, note…)
```

- The **AMK** is the root. It is stored on the server only as `wrap(passwordKEK, AMK)` and
  `wrap(recoveryKEK, AMK)`. The server never sees passwordKEK, recoveryKEK or AMK.
- Wrapping = XChaCha20-Poly1305 with associated data `"kithwall/v1/wrap/<purpose>/<user id>"`.

### 3.2 Sign-up
1. The browser derives `stretched`, then `authKey` and `passwordKEK` (§3.1). The salt depends only
   on the email, so login never needs a lookup that would reveal whether an account exists.
2. It generates AMK, IK_sig, IK_kx and a recovery phrase (RK).
3. It calls `supabase.auth.signUp({ email, password: base64url(authKey) })`. Supabase stores a
   bcrypt hash of authKey; the real password never leaves the device.
4. After email confirmation it uploads the **key bundle**: public keys, wrapped AMK (×2), the
   private identity keys encrypted under AMK, and `H(RK)` as a commitment.
5. The user must write down the 24 words, confirm three of them, and is offered trusted-friend
   recovery as soon as they have friends.
6. Password strength is checked on device (zxcvbn-ts, minimum score 3) and against the Supabase
   leaked-password check.

### 3.3 Login and new devices
`authKey` signs in to Supabase; the browser downloads its key bundle (only the owner can read it),
unwraps AMK with passwordKEK, decrypts the identity keys, and loads keyrings. **Changing your
password** re-wraps AMK and updates authKey in one step. **Changing your email** changes the salt,
so it re-derives and re-wraps the same way. Optional MFA (authenticator app) via Supabase.

### 3.4 Recovery with the 24-word key
Forgot password → email reset link → a session that can read only the wrapped bundle → the user
enters the 24 words → AMK unwrapped → new password set and AMK re-wrapped. Email access alone
is never enough.

### 3.5 Trusted-friend recovery (k-of-n)
**Setup.** The owner picks *n* friends (3–5) and a threshold *k* (default 2). The device splits RK
with Shamir into *n* shares; each share is sealed (§3.6) to that friend's IK_kx and signed with the
owner's IK_sig. Friends are told they're trusted contacts but **cannot see or use a share alone**.
Changing the set re-splits RK and deletes old shares.

**Recovery.**
1. The owner proves email control and starts a recovery request. Their new device creates an
   ephemeral X25519 key pair E; the request stores E's public key and expires in 72 hours.
2. Every logged-in session and the owner's email are notified. The owner can cancel from any of
   them. Shares cannot be released until a **24-hour waiting period** passes.
3. Each trustee sees a **6-word verification phrase** derived from `H(request id ‖ E_pub)`. The
   app tells them to call or meet the owner and compare phrases before approving.
4. On approval the trustee's device decrypts its share and re-seals it to E_pub.
5. With *k* shares the new device rebuilds RK, checks it against `H(RK)`, unwraps AMK, sets a new
   password, then generates a fresh RK and re-issues all shares.

### 3.6 Sealing a key to a person
`seal(recipient, key)`: ephemeral X25519 → shared secret with the recipient's IK_kx →
HKDF(shared, eph_pub ‖ recipient_pub, "kithwall/v1/seal") → XChaCha20-Poly1305. Every sealed
key that grants access (audience, conversation, recovery share) is also **signed by the sender's
IK_sig**, so the server can't inject a key of its own.

Signatures are checked against the identity key **this device trusts** for the signer, never simply
the one the server publishes (security re-review R-K-1): the key pinned when the device first saw that
person (§3.9), or a newer key that a chain of key changes signed by the pinned key vouches for. If the
server publishes a key that nothing signed by the pinned key vouches for (a swapped key), keys, epoch
records and admin grants signed with it are not adopted, content signed with it shows as "couldn't be
verified", and new keys are still sealed to the pinned key-exchange key, until the user accepts the change
("safety number changed" on the profile, in 1:1 chats, and in any circle or chat whose key it touched).
Trust on first use remains: a device that has never seen someone pins whatever is published then.

### 3.7 Audience keys and rotation
- Each user has a **Friends audience** with a 32-byte key per *epoch*. Custom friend lists,
  Closed/Secret groups and private events each have their own audience with the same structure.
- The owner's device seals the current epoch key to every member (`audience_keys` rows).
- **Removing someone** (unfriend, leave a list, kicked from a group) creates a new epoch, sealed
  only to the remaining members. New posts use the new epoch. Remaining members keep all older
  epochs, so history still opens for them.
- **Key delivery queue.** Keys can only be sealed by a device that holds them. When a friendship
  is accepted, each side's app delivers its own Friends key the next time it's open (a database
  view lists "friends I haven't given my current key to"). Until then the new friend sees
  "Waiting for Jessica's device to share her posts with you." Group and event admins work the same
  way.
- **Key authority and epoch records** (security review K1). Only the audience owner mints keys for
  Friends, self and list audiences; for groups, events and conversations the owner or an active admin.
  Minting publishes `audience_epochs(audience_id, epoch, rotated_by, commit, sig)`: a commitment
  `SHA-256(lp("kithwall/v1/epoch-commit", audience, epoch, key))` signed with the minter's IK_sig.
  Rotation is one call, `advance_audience_epoch(aud, from_epoch, commit, sig)` (compare-and-swap on the
  epoch). The database never accepts a key row for an epoch above the current one; other conversation
  members may only relay the current, recorded epoch. Clients adopt a key only if it matches the record
  (any relayer), or, for epochs without a record, if a key authority sealed it; a key that contradicts its
  record is rejected, discarded and reported as a security warning in the chat. A removed member can
  neither be given nor plant a post-rotation key.
- **Signed admin grants** (security re-review R-K-2). Making someone an admin (a key authority) carries
  `grant_sig = Ed25519(IK_sig of the promoter, {d:"kithwall/v1/admin-grant", audienceId, memberId,
  grantedBy})` in `audience_members.grant_by/grant_sig`. Clients count an admin as a key authority only if a
  chain of valid grants leads to the audience owner, each verified against the signer's trusted key; the
  database ignores admins without a grant too. Every join, promotion and change of owner produces a
  content-free server notice for the members (a notice message in group chats,
  `audience_roster_notices` in circles and events), and each device remembers who the key authorities
  were and warns prominently ("New admin: …") when someone new appears. Demoting an admin rotates the key,
  and an authority rotates whenever the current epoch's record no longer counts (its rotator was demoted, or
  signed with an untrusted key).
- **Relays never beat the authority** (R-K-3): a delivery by a key authority replaces a member's relay of
  the same epoch, relays don't count as delivered for the authority, and only authorities may re-sign
  their deliveries.

### 3.8 Envelope format (posts, comments, albums, notes, events, profile info…)
```
Envelope v1
  header = { v:1, type, id, author_id, wall_owner_id?, audience:{id, epoch} | "self" }
  wk     = XChaCha(audienceKey[epoch], contentKey, aad = header)     // wrapped content key
  n, ct  = XChaCha(contentKey, payload JSON, aad = header)
  sig    = Ed25519(IK_sig, SHA-256(canonical(header) ‖ wk ‖ n ‖ ct))
```
- Binding the header as associated data means the server can't move a ciphertext to a different
  row, author or audience without decryption failing.
- Clients **verify the signature before display**. Anything that fails is hidden and reported as
  "This item couldn't be verified."
- **Comments** use a key derived from the post's content key (`HKDF(CK, "comment" ‖ comment_id)`),
  so anyone who can read a post can read and write its comments, and nobody else can.
- **Payloads** hold everything readable: text, link URL and preview, photo file keys, tags, check-in
  place and tagged friends, poll options, event details.
- **Public** items skip encryption: `public_body` (JSON) is stored in the clear and still signed.

### 3.9 Proof-of-key for destructive actions
Deleting the account, deleting all posts and changing recovery settings require the browser to sign
a fresh server nonce with IK_sig. A Vercel route handler verifies the signature against the stored
public key before acting. Someone who has only hijacked the email/password session can't destroy
the account.

**Adding a way in** (a passkey, or a passphrase on an email-less account) also requires proof-of-key: the
browser signs the WebAuthn challenge of the add ceremony (`kithwall/v1/add-passkey/<challenge>`), or a
fresh `add_credential` nonce, with IK_sig. Every device gets a content-free `security_notice`
notification (and push), and the notice address an email (security review W2).

**Identity keys** (`profiles.sign_pub`, `kx_pub`, `key_version`) are immutable in the database except
through `apply_identity_key_change`, which only the server may call, after `/api/account/identity-key`
checked a fresh `rotate_identity` proof-of-key and the key-change statement signed by the current IK_sig
(aal2 when an authenticator app is enrolled). The signed statement is logged in `key_changes`. Clients pin
every contact's keys on first use (in the encrypted vault) and show "your safety number changed" for ANY
change; until the user accepts, they do not seal new keys to a changed identity of a verified contact or
to a change that no chain of signatures from the pinned key vouches for (security review K2), and they
verify everything that person signs against the pinned key (re-review R-K-1, §3.6). There is no
key reset without the old key: someone who lost every device and the recovery key deletes the account.

**Key bundles** (the wrapped AMK and identity keys) are written only by the server: at sign-up (definer
RPCs), on an identity-key rotation, and through `/api/account/bundle`, which needs a fresh `update_bundle`
proof-of-key (aal2 when enrolled) and refuses any change to the identity part (`signPub`, `kxPub`,
`identityEnc`, `prevKxEnc`). Password/passphrase changes and new recovery keys go through it, so a stolen
session alone can't destroy the wrapped keys (re-review R-K-5).

### 3.10 Messages and chat
One system (as in Facebook's November 2010 Messages): a **conversation** has a key per epoch,
sealed to each member. Messages are envelopes (§3.8) under that key. Adding or removing members
rotates the epoch. Typing indicators and "online" presence travel over Realtime and contain no
content. Presence can be turned off ("Go offline"). v1 has no forward secrecy (see §2).

### 3.11 Photos and files
1. Decode in the browser and re-encode with OffscreenCanvas. This drops all EXIF/GPS metadata.
2. Make three sizes (2048 px, 720 px, 206 px — the 2010 sizes).
3. Encrypt each with a fresh file key in 64 KiB chunks (XChaCha20-Poly1305; chunk index and
   last-chunk flag in the associated data to stop reordering or truncation).
4. Upload to the private `media` bucket at `{owner_id}/{random uuid}`. File keys go inside the
   post or album envelope; storage paths are random and reveal nothing.
5. Downloads use short-lived signed URLs; decryption happens into `blob:` URLs.
Limit: 20 MB per original photo. Video (R3) uses the same chunked scheme.

### 3.12 Notifications
Rows hold `recipient, type, actor, object reference, read_at` (metadata). Any human-readable
preview ("Kevin commented: lol yes") is **sealed to the recipient**. Notifications are created
through an RPC that checks the actor is allowed to notify the recipient (friend, participant,
group member) and rate-limits it.

### 3.13 On-device storage
AMK lives in Worker memory. For "Keep me logged in", AMK is stored in IndexedDB wrapped by a
**non-extractable** WebCrypto AES-GCM device key. The decrypted cache is encrypted with cacheKey.
The app auto-locks after 30 minutes idle (configurable); locking wipes in-memory keys. Logging out
deletes the device key and cache.

---

## 4. Data model (Postgres, `public` schema, RLS enabled on every table)

| Table | Key columns | Visible to |
|---|---|---|
| `profiles` | id (= auth uid), username (citext, unique), display_name?, discoverable, avatar_public, sign_pub, kx_pub, key_version | The person, their connections (incl. pending requests), friends of friends, people they share a circle/event/chat with, staff, and everyone for discoverable profiles. Anyone else: one row by **exact** handle through `find_profile()` (rate-limited; security review D3) |
| `key_bundles` | user_id, kdf params, amk_by_password, amk_by_recovery, identity_priv_enc, rk_commitment | Owner only |
| `key_changes` | user_id, old/new public keys, signature by old key, created_at | Signed-in users |
| `recovery_shares` | owner_id, trustee_id, setup_id, sealed_share, sig | Owner and that trustee |
| `recovery_requests` / `recovery_responses` | owner, eph_pub, status, not_before, expires_at / request_id, trustee, sealed_to_eph | Owner and that owner's trustees |
| `friendships` | user_a < user_b, status (pending/accepted), requested_by, timestamps | The two people |
| `blocks` | blocker, blocked | Blocker |
| `audiences` | id, owner_id, kind (friends/list/group/event/conversation), current_epoch, name_enc | Owner and members |
| `audience_members` | audience_id, member_id, role | Owner and members |
| `audience_keys` | audience_id, epoch, recipient_id, sealed_key, sig | The recipient and the owner |
| `posts` | id, author_id, wall_owner_id, kind, audience_id (null = public), epoch, envelope / public_body, created_at, deleted_at | Author, wall owner, audience members; everyone signed-in for public |
| `comments` | id, post_id, author_id, envelope, created_at | Whoever can read the post |
| `likes` | target_kind, target_id, user_id | Whoever can read the target |
| `albums`, `media` | owner, audience, envelope / storage path, size | Whoever can read the album/post |
| `tag_notices` | media_id, tagged_user_id, status (pending/approved/removed) | Owner, tagger, tagged person |
| `conversations`, `conversation_members`, `messages`, `message_reads` | conversation id, epoch, envelope | Members. Only people you're connected to (or share a circle with and who accept requests) can be added (`create_conversation()`, security review D2). While someone blocks you, you can't read your 1:1 chat with them; group chats are a shared key, so a blocked person in the same group still sees the group |
| `notifications` | recipient, type, actor, object ref, sealed_preview, read_at | Recipient |
| `pokes` | from, to, created_at | The two people |
| `groups`, `events`, `event_rsvps` | privacy, audience_id, public fields for open/public ones, envelope otherwise | Members / invitees; public ones to all |
| `pages`, `page_likes` | pages are public; page_likes visible to the liker only; counts via a function | — |
| `poll_votes` | post_id, voter_id, envelope | Readers of the poll |
| `vault` | user_id, envelope (private settings, list names, game state) | Owner |
| `reports` | reporter, target, reason, disclosed content key + plaintext, status | Reporter, moderators |
| `invites` | code, inviter, expires_at, uses | Inviter |

**Constraints:** ciphertext size caps (posts 64 KB, comments 8 KB, messages 64 KB); `user_a < user_b`
on friendships; exactly one of `envelope` / `public_body`; cascading deletes from `auth.users`.

### 4.1 RLS rules (summary)
Helper functions are `SECURITY DEFINER`, `STABLE`, with `search_path = ''`:
`kw.is_friend(a, b)`, `kw.is_blocked(a, b)`, `kw.is_member(audience, user)`, `kw.can_read_post(post)`.

- **Read a post**: you are the author or wall owner; or it is public and neither side has blocked
  the other; or you are a member of its audience (for a Friends audience: you are the owner's friend).
- **Write a post**: `author_id = auth.uid()`; on your own wall, or on a friend's wall with no block;
  the audience must belong to you or (for a friend's wall) to that friend.
- **Comments / likes**: allowed where `can_read_post` is true; you can delete your own, and the post
  owner can delete any on their post.
- **Key bundles, vault, notifications**: owner only. `audience_keys`: recipient or owner.
- Realtime `postgres_changes` carries INSERT and UPDATE only (RLS-filtered); DELETE events, which Realtime can't
  filter, are not published at all. Deletes a client must hear about arrive as content-free broadcasts on the
  private `db:<user id>` topic (security review D1).
- Blocking is enforced in every helper. Nothing is readable by the `anon` role except the sign-up
  splash content.
- Abuse limits live in `kw.rate_limit(action, max, window)`, called from insert policies and RPCs
  (e.g. 50 friend requests/day, 100 pokes/day, 1,000 messages/day).

---

## 5. Key flows

| Flow | Steps |
|---|---|
| **Add friend** | A inserts a pending friendship (rate-limited, optional sealed note) → B is notified → B accepts → each app delivers its Friends key (§3.7) → both feeds fill in |
| **Post** | Publisher → Worker builds payload → envelope under the current epoch → insert row (+ media uploads) → notify tagged people |
| **Feed** | Page through `posts` newest first (cursor pagination, 20 at a time) → Worker verifies and decrypts → **Most Recent** shows them in order; **Top News** re-ranks the last 7 days on device by likes, comments and how often you interact with the author |
| **Unfriend** | Delete the friendship → rotate your Friends epoch → reseal to remaining friends → the ex-friend loses RLS access to your posts and can't decrypt new ones |
| **Report** | The reporter's device attaches the decrypted item and its content key; moderators can check the content key decrypts the stored ciphertext, so reports can't be forged |
| **Export** | Worker fetches everything you can read, decrypts it, and builds a ZIP (HTML + JSON + photos) on device |
| **Delete account** | Proof-of-key → route handler deletes auth user (cascades all rows) and your storage folder → keys gone = remaining ciphertext copies (backups) are unreadable |

---

## 6. Frontend

### 6.1 Routes (mapping of the 36 reference screens)
`/` splash or News Feed · `/login` · `/signup` · `/recover` (+ `/recover/friends`) ·
`/[username]` wall · `/[username]/info` · `/[username]/photos` · `/[username]/notes` ·
`/[username]/friends` · `/friends` · `/requests` · `/pokes` · `/messages` (+ `/messages/[id]`) ·
`/notifications` · `/photos/album/[id]` · `/photos/[id]` · `/photos/new` · `/post/[id]` ·
`/events` (+ `/new`, `/[id]`) · `/groups` (+ `/new`, `/[id]`) · `/pages` (+ `/[id]`) · `/places`
(+ `/[id]`) · `/questions` · `/notes` (+ `/new`, `/[id]`) · `/games/kithville` · `/apps` · `/search`
· `/invite` · `/help` · `/settings/account` · `/settings/privacy` · `/settings/security`
(MFA, sessions, recovery, trusted friends) · `/settings/profile` (edit profile tabs).

### 6.2 Look and feel
- Design tokens from the reference: `#3b5998` header, `#6d84b4`, `#d8dfea`, `#eceff5`, `#f7f7f7`,
  link blue `#3b5998`, red jewel badges `#f03d25`; font stack `"lucida grande", tahoma, verdana,
  arial, sans-serif`; 11 px base on desktop. **No web fonts and no third-party assets.**
- Components reproduce the reference: header with jewels and flyouts, left nav, publisher, story
  with Like · Comment · Share, comment thread, right-column boxes, bottom-right chat bar and docked
  windows, profile info strip and photo strip, dialogs (2010 grey-bordered style).
- Additions shown in the 2010 style: a padlock on encrypted items, a globe + "Public — not
  encrypted" on public ones, and the "waiting for key" state.

### 6.3 Responsive layouts
| Width | Layout |
|---|---|
| **≥ 1024 px** | Exact 2010 desktop: 980 px centred; left nav 180 px · feed ~500 px · right column 244 px; chat bar bottom-right |
| **768–1023 px** | Right column moves under the feed; left nav becomes icon-only; chat opens as a side panel |
| **< 768 px** | Mobile layout in the spirit of 2010's touch site: blue top bar with logo, three jewels and search; left nav in a slide-out drawer; single column; profile columns stack; chat becomes full-screen Messages; photo viewer full-screen with swipe; 13 px base text; tap targets ≥ 44 px |

Installable as a PWA (manifest + service worker that caches only the app shell, never user data).

### 6.4 Accessibility
WCAG 2.2 AA: full keyboard support for jewels/menus/dialogs, ARIA roles, visible focus, alt text
field on photo upload, `prefers-reduced-motion`. The 2010 light-grey text (`#999`) is darkened to
meet contrast (`#737373` minimum).

---

## 7. Security controls

| Area | Control |
|---|---|
| Headers | CSP: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'; connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'nonce-…'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` (Trusted Types: see §12); HSTS (preload); COOP `same-origin`; CORP `same-site`; `Referrer-Policy: no-referrer`; Permissions-Policy denying everything except `camera=(self)` and `geolocation=(self)` |
| App code | React escaping only; user links limited to `http(s)` and opened with `rel="noopener noreferrer"`; no `dangerouslySetInnerHTML` for user data; all crypto in one package with 100% branch coverage |
| Auth | Email confirmation on; leaked-password protection; MFA (TOTP); 1-hour JWTs with refresh-token rotation; session list with "log out other sessions" |
| Sign-up abuse | Self-hosted proof-of-work captcha (ALTCHA, no third party) checked by a Supabase "before user created" auth hook calling a Vercel route |
| Secrets | Only the publishable key is shipped to browsers; the secret key lives in Vercel server env vars and is used by two route handlers only |
| Supply chain | Lockfile, Dependabot, `npm audit` + CodeQL in CI, pinned GitHub Actions, no CDN scripts |
| Logging & privacy | No IP addresses or user agents in app tables; Vercel Web Analytics off; Supabase auth logs are the only IP record (kept per Supabase's retention) |
| Ops | Supabase daily backups (ciphertext only); migrations reviewed in PRs; production database changes only through migrations |

### 7.1 Data retention
| Data | Kept |
|---|---|
| Your content | Until you delete it. Deletion is immediate in the database; backups age out within 7 days |
| Deleted account | Immediately removed; keys destroyed, so backup copies are unreadable |
| Notifications | 90 days |
| Recovery requests | 7 days after they close |
| Reports | 1 year after resolution |

---

## 8. Testing

| Layer | What we test |
|---|---|
| Crypto (Vitest) | Published test vectors for HKDF, XChaCha20-Poly1305, X25519, Ed25519, Argon2id; round-trips; **tampering** (any changed byte, wrong AAD, wrong epoch, wrong signer → rejected); Shamir every k-of-n combination; recovery end-to-end |
| Database (pgTAP) | One test per RLS rule: strangers can't read friends' posts; blocked users can't read or write; ex-friends can't fetch; no one reads another's key bundle; wall-post insert rules; rate limits |
| End-to-end (Playwright) | Three browser contexts (A, B, stranger C): sign-up with recovery key → friend request → post with photo → B sees it decrypted, C sees nothing → chat → unfriend → B can't see new posts → password reset with 24 words → trusted-friend recovery with the 24-hour wait shortened in test mode |
| **Plaintext canary** | E2E test posts a random marker string, then dumps every table and the storage bucket and fails if the marker appears anywhere |
| Visual | Screenshot comparison against the 2010 reference at 1280 px, plus 390 px and 820 px layouts |
| Accessibility | axe-core on every route in Playwright |

CI (GitHub Actions) runs lint, typecheck, unit, pgTAP (local Supabase in Docker) and Playwright on
every PR; `main` must stay green.

---

## 9. Deployment

| Item | Value |
|---|---|
| Vercel project | Import GitHub `443abdul/kithwall`; **Root Directory `apps/web`**; framework Next.js |
| Env vars | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (server), `ALTCHA_HMAC_KEY`, `AUTH_HOOK_SECRET` |
| Supabase | New project (pending approval). Auth: site URL + redirect URLs for the Vercel domain, email confirmation, MFA, leaked-password check, custom SMTP for auth emails (needed for production volume) |
| Migrations | `supabase/migrations` applied with `supabase db push`; production only after CI passes |
| Domain | kithwall.com (or .app) pointed at Vercel once purchased |

---

## 10. Acceptance criteria

**R0 Foundation:** CI green; schema and every RLS rule covered by pgTAP; crypto package passes
vectors and tamper tests; app shell matches the 2010 header/left nav/right column at 1280 px and
renders the mobile layout at 390 px.

**R1 Core social:** on the deployed site, two new users can sign up (saving recovery keys),
befriend each other, post statuses and photos (with tags), like and comment, chat in real time and
see notifications; a stranger sees none of it; unfriending stops access to new posts; password
reset works with the 24 words and with 2-of-3 trusted friends; export and delete work; the
plaintext canary finds nothing; Lighthouse accessibility ≥ 95 on Home, Profile and Messages.

---

## 11. Decisions needed from the owner
1. **Supabase project:** new dedicated project ($10/month) — recommended — or 17g.
2. **Domain:** buy kithwall.com ($11.25/yr) or another TLD.
3. **Public posts:** keep the "Public" audience (needed for Pages, Open Groups, public profiles),
   or launch friends-only.
4. **Moderation:** who reviews reports.
5. **Auth email sender:** a transactional email provider for custom SMTP (e.g. Resend or Postmark).
6. **Legal:** a lawyer should review the privacy policy and terms before public launch. I'll draft
   plain-language versions.

---

## 12. Implementation notes (decisions made during the build)

| Topic | Decision |
|---|---|
| Launch audience | **Friends-only.** `app_settings.public_audience_enabled = false`; admins can switch Public on later from `/mod`. Pages, Open groups and public events only work while it is on. |
| Moderators | Accounts listed in `staff_roles`. The owner bootstraps the first `admin` in SQL; admins appoint moderators from `/mod`. Moderators see only reported items (plus the disclosed key), never a blanket view. |
| Signatures | Computed over canonical JSON with a domain string (not the raw `SHA-256(header‖wk‖n‖ct)` in §3.8, which lacked length separation). See `packages/crypto/README.md`. |
| Identity key wrap | Private identity keys are encrypted under `HKDF(AMK, "kithwall/v1/identity-key")`, not the AMK directly. |
| Argon2 floor | Clients refuse Argon2 parameters weaker than m = 64 MiB, t = 3, so a malicious server can't downgrade password stretching. |
| Envelope storage | Envelopes are stored as `jsonb` (base64url fields), not `bytea`. |
| Comments | Header binds the comment id, author and parent id; key = `HKDF(contentKey, comment, commentId)`. |
| Friend lists for friends | Your friend list is published inside your encrypted profile info (unless hidden), so friends can see mutual friends and People You May Know is computed on device. |
| Tag notices | Readable by anyone who can read the photo (they already see the tags inside the photo payload). |
| Web Worker | Crypto runs on the main thread in v1; Argon2 runs once per login. Moving it to a Worker is a performance task, not a security boundary. |
| Email change | Not supported in v1: the password salt is derived from the email. A pre-login salt lookup (with fake salts for unknown emails) will lift this. |
| Minimum age | 16 (client-side check at sign-up; birthday stays encrypted). India's DPDP Act treats under-18s as children — the owner should decide on 18 for India. |
| Lost-everything deletion | Users without keys can request deletion via email; it executes after a 72-hour delay (proof-of-key impossible). |
| Trusted Types | **Deferred.** With `require-trusted-types-for 'script'`, Next 16's Turbopack chunk loader stalls client-side navigation even with a strict default policy. XSS defence today: per-request nonce + `strict-dynamic`, no user HTML anywhere (`react/no-danger` is a lint error), React escaping. Re-enable when Next supports it (tracked as a follow-up). |
| Realtime transport | `upgrade-insecure-requests` is only sent when Supabase is served over HTTPS (always in production). |
| Push notifications | **Web Push (VAPID, RFC 8030/8291/8292)**, opt-in per device (Settings → Account → Push Notifications; a dismissible News Feed card invites people). Text is **"who + what" only** — "dan sent you a message", "dan sent a message to a group conversation", "jessica commented on your post" — using the actor's `@username` (or `display_name_public` if they are discoverable); never message/post content, which the server can't read anyway. Flow: AFTER INSERT triggers on `notifications` and `messages` → `pg_net` POSTs `{kind, id}` (ids only) with `x-kw-push-secret` to `/api/push/dispatch` (Vercel, Node) → `push_plan()` (service-role-only SQL) returns recipients (notification recipient; or conversation members except the sender, skipping members who left and blockers), their devices, preferences and unread badge count → `web-push` sends (TTL 1 day; urgency high for messages and security). Payloads are encrypted for the browser (RFC 8291), so the browser vendor's push service — Google FCM, Apple APNs, Mozilla autopush, Microsoft WNS — sees only that a push was sent, when and its size. 404/410 responses delete the subscription. Endpoints are restricted to those push services (DB CHECK + route) so dispatch can't be aimed at other hosts. Stored per device: endpoint, `p256dh`/`auth` keys, a coarse label ("Chrome on Android", never the raw user agent), created/last-success times; per person: which categories to push (`push_preferences`). Both owner-only RLS + `require_mfa`. Dispatch URL and secret live in `kw.push_config` (not exposed by the Data API); with no row, triggers do nothing; trigger errors never fail the insert. Turning push off deletes the row and unsubscribes; logging out unsubscribes the browser (the row is removed on the next 410). |
| Service worker | `public/sw.js` is push-only: **no fetch handler, no caches** (nothing user-related is stored by it). It skips the notification when a focused window already shows that conversation, sets the app badge, and on click focuses an open tab and navigates it in-app (keeps unlocked keys) or opens a new window. `pushsubscriptionchange` re-subscribes and proves ownership of the old subscription with its endpoint + auth secret (`/api/push/resubscribe`). |
| Installable app | Manifest with PNG icons (any + maskable, 192/512), Apple touch icon and `appleWebApp` metadata. Settings offers "Install Kithwall" via `beforeinstallprompt` (Chrome/Edge) and Share → Add to Home Screen steps on iOS, where web push only works for Home Screen apps (iOS 16.4+). Browsers can't keep a closed site running; push is how people are reached when Kithwall is closed. |
