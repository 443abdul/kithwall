# Roadmap: social features and privacy hardening (Nov 2026)

Written 2026-10-30 after the owner asked for (a) the popular features of Facebook, Reddit, X and others, with
full per-person control over what shows on a profile, and (b) the latest privacy and cryptography work
applied to Kithwall. Everything below keeps the rule that the server only ever sees ciphertext and the
minimum metadata.

## Already shipped in this round

- Calls: the quality controller measured upload loss from a value Chrome only refreshes when a receiver
  report arrives, so a paused video stream kept its last (often high) loss for the rest of the call and
  pinned calls in "voice only" on good links. Loss is now computed from packet counters per sample
  (`deltaLoss` in `lib/calls/quality.ts`).
- Android app: full-screen video (embeds and our own player) now works; Capacitor's client used to cancel
  every full-screen request (`KwChromeClient.onShowCustomView`). Back leaves full screen.
- Notifications: the button no longer waits forever when Chrome on Android parks the permission request in
  its quiet UI (20 s timeout + "tap the bell next to the address"), says what to do when notifications are
  blocked, and in the app opens the system notification settings (`KithwallPush.openSettings`).
- Short video statuses (up to 60 s / 50 MB), encrypted on the device like post videos.

## Batch 1: social features (shipped 2026-10-30)

| Feature | Why | E2EE design |
|---|---|---|
| Per-field profile visibility (only me / close friends / connections / circle) | The owner's main ask: full control of what shows on a profile | Split `ProfileInfo` into tiers, one envelope per audience (the `profile_info` key is already `(user_id, audience_id)`); field→tier map in the vault |
| Close friends list | Lets the tiers above (and posts/stories) target a smaller group | `audiences.kind = 'list'` already exists |
| Repost / share with comment | Core FB/X feature; `share` kind and `shared_post_id` exist, no UI | Re-seal the shared payload to the sharer's audience |
| Polls (posts and chats) | High use everywhere | Votes encrypted under a subkey of the post key; the author's device tallies |
| @mentions in posts and comments | Notifies the person; the `mention` activity type exists | Ids inside the payload + a sealed notification |
| Saved posts (bookmarks) | Cheap, popular | Vault namespace, never on the server |
| Story reactions and replies | Instagram/WhatsApp habit | Reply goes as a normal encrypted DM |
| Multi-emoji reactions on posts | FB/Discord | Same as `message_reactions` (encrypted) |
| Pinned post on profile, drafts, mute/snooze a person or circle, birthday reminders | Small, frequently asked | All in the vault or inside sealed envelopes |

## Batch 2: privacy and security hardening (from the research brief; status as of 2026-10-30)

Ranked by impact for effort. Shipped: 1 (signed member additions, `lib/keys/authority.ts memberVouched`),
2 (media from non-connections in chats stays inert until tapped), 3 (hybrid X25519 + ML-KEM-768 key
wrapping, `packages/crypto/src/pq.ts`, seal v2), 6 (Padme padding of every encrypted payload), 7 (public
key-transparency log, 2026-11-02: an RFC 9162 Merkle log of every identity-key publication with salted,
non-enumerable leaves, consistency and inclusion checks on every device, warnings through the existing
safety-number notices, and a daily public witness on the `kt-heads` branch; `docs/v2/09-key-transparency.md`),
part of 8 (Settings → About shows whether the installed app carries Kithwall's signing certificate), part
of 9 (chat messages written offline send themselves when the connection returns) and since 2026-11-02 the
message franking part of 10 (`03-franking.md`). Already in place before this round: 4 (calls use
RTCRtpScriptTransform when available), 5 (passkey PRF unlock), the strict nonce CSP, and key-change warnings
with a vouched key-change chain. Still open: automatic gossip of key-log heads between contacts and
VRF-indexed self-monitoring (09 §9), a second non-Cloudflare CDN and bridges (needs owner accounts), and the
legal review of PECA/SMPRA (10).

1. **Signed circle membership changes.** Clients reject members the server added on its own, and show a
   system line for every add/remove (cf. the 2025 WhatsApp group analysis, ePrint 2025/794).
2. **Inert media from non-connections.** No automatic decoding of media or documents from people you are
   not connected to; decode/re-encode in a worker, strip metadata (lesson of the 2025 Paragon zero-clicks).
3. **Hybrid post-quantum key wrapping.** X25519 + ML-KEM-768 for audience-key wraps and sealed envelopes,
   with a suite byte for future changes (Signal SPQR, Oct 2025). Library: `@noble/post-quantum` (not yet
   independently audited, so keep the classical layer).
4. **Calls on RTCRtpScriptTransform** (now in all engines) with SFrame-style framing (RFC 9605).
5. **Passkey PRF** to unlock the account key without typing the passphrase where the authenticator supports
   it (Google Password Manager, iCloud Keychain); the passphrase stays as the fallback.
6. **Padding** of post/message/push ciphertexts to size buckets.
7. **Key transparency**: an append-only public log of identity keys, plus key-change warnings (shipped as an
   unsigned Merkle log with a public witness instead of a server signing key: 09-key-transparency.md).
8. **Client integrity**: strict CSP and SRI, published hashes per release and per signed APK (fake
   "Kithwall" APKs are a realistic threat), and bundling the web assets inside the Android app instead of
   loading the site remotely.
9. **Censorship**: second non-Cloudflare CDN for mirrors, Snowflake/WebTunnel bridges alongside Orbot, an
   offline queue for posts and messages during shutdowns.
10. **Compliance without breaking E2EE**: message franking for reports, a transparency report, and legal
    advice on Pakistan's PECA 2025 social media authority (SMPRA) before any registration decision.
    *Message franking shipped 2026-11-02* (D7, `03-franking.md`, migration `20261102000600_message_franking.sql`):
    every message and edit commits to its content with a per-message key sealed inside it, the database tags
    the commitment with the sender, chat and time under a key only it holds, recipients check it on arrival,
    and reports that include the message are verified by the database and shown to moderators as verified or
    "couldn't be verified", also after an edit, unsend or expiry. The legal review is still open.

## Not recommended

Server-side search and trending **of encrypted content**, marketplace, live streaming and federation: each
needs the server to read content or makes the anonymity set public. Local (on-device) search of decrypted
posts is the substitute. (Round 4 adds search and a popular list for what people explicitly made public:
accounts that let people follow them, and Public posts. Nothing encrypted is searched or ranked.)

## Round 3 (2026-11-01): review fixes, notifications, new features

- **Signed member additions, reworked after review.** The server's `created_at` no longer grandfathers
  anyone; earlier members are accepted on cryptographic proof (a key delivery to them signed by a key
  authority, checked with `sealedSignatureValid`, fetched through `member_key_proofs`). Any current member
  may vouch for people they added (as the database rules allow), invited members are covered, unvouched
  signer keys are refused, and `resealMine` re-signs additions after an identity change.
- **Notifications (Android).** The device registration is dropped only on an explicit sign-out (a session
  that failed to load at start-up used to delete the push token silently), a lost token is re-registered on
  the next sign-in, the permission is re-read when the app returns to the foreground, token requests time
  out after 45 s, failures say what went wrong (with a code), and the test notification reports when no
  device received it. Verified on an emulator with both a debug and a release-shrunk build.
- **Tor (Orbot) users:** the app no longer crashes on launch (bridge built in onCreate, network held until
  the proxy is confirmed).
- **Fixes:** close-friends stories (kw.can_story), close-friends profile fields kept in the vault, reactions
  sealed before the old one is removed, offline chat queue survives leaving the chat and never duplicates a
  message, UnifiedPush timers, MFA rule on post_votes.
- **New: time capsules.** Posts sealed with drand timelock encryption (tlock) that nobody can open before the
  chosen date; beacons come through our own relay (`/api/drand/...`) and are verified against the pinned
  quicknet key.
- **New: scam and impersonation shield.** Connection requests and strangers' profiles show account age,
  mutual connections (from connections' own encrypted friend lists) and a warning when a name or @handle
  imitates one of your connections (homoglyph-aware, `lib/social/lookalike.ts`).
- Next from the research: Data Saver mode, offline "Kit Drop" bundles for shutdowns, on-device translation,
  legacy contact.

## Round 4 (2026-11-11): follow, Followers and Public posts, Explore

The owner's ask: Kithwall should also work for the general public, without giving up the privacy promise.
Design, threat model and production steps: `10-follow-public.md`. In short:

- **Follow** is opt-in per account ("Let people follow me", off by default). Following is instant; the
  account can remove or block followers; connections count as followers. People who never turn it on keep
  the connections-only Kithwall unchanged.
- **Followers posts are still end-to-end encrypted**: a per-account followers audience whose key the owner's
  own devices mint, sign and hand to each follower (the same machinery as the connections key, hybrid
  post-quantum wraps included). A new follower reads nothing until one of those devices has been online, and
  the app says so. Removing or blocking a follower rotates the key.
- **Public posts** are signed plaintext, labelled Public everywhere, explained once before the first one,
  open without an account through `/p/<id>` (noindex unless the author opts in), with photos, videos,
  comments and reactions.
- **Explore**: popular and newest public posts (ranked from public likes, comments and age only; nothing
  about what anyone views is recorded), search that returns only follow-enabled accounts, and suggested
  accounts computed on the device from who one's connections follow.
- **Comment controls**: who can comment (per account and per post), who can mention me, authors remove
  comments, restrict, and a hidden-words list kept in the encrypted vault.
- **Safety**: public content is reportable and reaches moderators as verified plain text; a public post is
  hidden after reports from 5 accounts until a moderator reviews it; rate limits on follows and public posts;
  a 24-hour wait for new accounts.
- Left as a seam for a short-video feed: `fetchPublicPosts({ kinds: ['video'] })`, `<PublicFeed>`,
  `EXPLORE_TABS` (10-follow-public.md §5). Used by reels in round 5 (kind `reel`).
- Next: a public picture and bio for follow-enabled accounts, reposting to followers, batched key delivery
  for very large accounts (10-follow-public.md §9).

## Round 4, continued: games inside chats

- **New: games in any chat** (`11-games.md`). Tic-tac-toe, chess with the full rules, checkers (English
  draughts), Connect Four, Reversi, Ludo for 2–4 with fair dice, Five in a Row, Dots and Boxes and Mancala.
  A game is made of ordinary end-to-end encrypted chat messages (a new payload kind, covered by franking),
  so it can be played at the players' own pace, survives bad connections through the chat's send queue,
  and needs **no database change**: no table, column, RPC or setting. The conversation shows one card per
  game that updates in place; the conversation list says "Chess: your move"; the chat's info screen lists
  games and the score, counted on the device.
- **Every device checks every move** with the same rule engine: an illegal or out-of-turn move from a
  changed app is ignored everywhere and shown as "X sent a move that isn't allowed".
- **Fair dice** by commit-reveal threaded through the turn messages: no player and not the server can
  choose or predict a roll, every device verifies every roll, and there is no waiting beyond normal turns.
  Protocol, security argument and limits in `11-games.md` §5.
- **Clocks** (optional) run on the server's `created_at` of the move messages, never on a device's clock;
  the other player claims a win on time and every device checks the claim.
- **Disappearing messages:** every game message carries the whole position, so a game goes on after its
  first messages have expired (`11-games.md` §7).
- Not included: Battleship (needs hidden boards kept across devices and a reveal-and-audit phase; left
  out rather than shipped half-checked), a computer opponent, ratings.

## Round 5 (2026-11-11): reels

The owner's ask: short vertical videos, the "scroll and stay" surface people expect, without watching the
watcher. Design, exactly what the server does and does not learn, encoding, limits and costs:
`12-reels.md`. In short:

- **A reel is a post of kind `reel`**: one video of at most 60 seconds, a cover, a caption, for Public,
  Followers or any existing audience. No new table or column; reports, automatic hiding, moderators, blocks,
  comment controls and hidden words apply as they do to posts.
- **Made on the device**: pick or record, trim, choose a cover, and the video is re-encoded to at most 720p
  (about 7 MB a minute; WebCodecs with `mp4-muxer`, else MediaRecorder, else the original only when it is
  already small enough) before it is encrypted and uploaded, with progress and cancel. The database enforces a
  size cap measured by the storage service and a daily limit per account.
- **Watched full screen**: one reel per screen, plays muted until tapped, pauses out of view and in the
  background, tap to pause, double tap to like, comments in a sheet, share, report, "Not interested";
  keyboard and screen-reader support, reduced motion, Data Saver (cover and a play button, nothing fetched
  ahead), Android Back.
- **Ranked on the device**: the server hands out generic pages (followed reels by time; public reels by
  popularity and by time). The device orders them with a small interest profile kept encrypted in IndexedDB,
  never uploaded, resettable in Settings → Reels. "You're all caught up" comes before discovery continues.
  **The server gets no watch events, impressions or watch time**; what it can still see is which media files
  an account downloads, as with any media (said plainly in `12-reels.md` §4).
- **Time controls**, on the device and off by default: a daily limit (15 / 30 / 45 / 60 minutes) with a calm
  "You've reached the limit you set" screen, and a "take a break" reminder.
- Where it lives: a Reels tab in Explore and a shelf on Home. No seventh item in the main navigation.
- Next: faster-than-real-time encoding (a demuxer feeding `VideoDecoder`), a relay or decoys to blur the
  media download trail, streaming playback (`12-reels.md` §9).

## Round 4 (2026-11-11): four smaller features

Built on a branch; the web parts were checked in a browser against a local build, the Android parts are
compiled only and wait for the device check in `05-native.md` §14.3.

- **Disguised app icon** (Android app). Safety centre → App lock → App icon: show on the home screen as
  Kithwall, Calculator, Notes or Weather (name and icon). Launcher entries are activity-aliases; the default
  one keeps the old component name, so existing home-screen icons survive the update. The screen says what a
  disguise doesn't hide (the system's app list, notifications, calls). `03-safety.md` §13, `05-native.md` §14.
- **Blur faces before posting.** In the composer and on chat attachments: faces are found on the device and
  covered with a destructive mosaic, tap a face to show it, drag to cover anything else; the covered copy
  replaces the picked photo before it is re-encoded, encrypted and uploaded. Browser `FaceDetector` where it
  exists, otherwise a 240 kB self-hosted detector (no WASM, no CSP change). `03-safety.md` §15.
- **Search on your phone.** The substitute for server-side search named under "Not recommended" above: an
  index of the text this device has decrypted, encrypted at rest under a key derived from the account key,
  searched on the device; in Messages (across chats and inside one, jumping to the message) and for posts
  (`/you/search`). Works across the app's scripts (Urdu, Arabic, Persian, Hindi, Bengali, Chinese…). Follows
  hidden chats, disappearing messages, edits, unsends and blocks; deleted on sign-out and by both wipes.
  `03-safety.md` §14.
- **Crash reports, opt-in.** Off by default. A scrubbed technical report to Kithwall's own server (no account,
  no IP stored, no content), grouped by fingerprint under `/mod` → Admin, deleted after 30 days; "See what gets
  sent" shows the exact report. Includes crashes of the Android app itself. `03-transparency.md` §6.
- Still open from this round: the device check of the Android parts; translating the new strings; a stronger
  face detector if the small one proves too weak in practice (the seam is `lib/photo/faces.ts`); search in
  album photo comments and stories (not indexed).
