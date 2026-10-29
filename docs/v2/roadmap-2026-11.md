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

## Batch 1: social features (recommended next, ~1–2 weeks)

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

## Batch 2: privacy and security hardening (from the research brief)

Ranked by impact for effort:

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
7. **Key transparency**: an append-only signed log of identity-key changes, plus key-change warnings.
8. **Client integrity**: strict CSP and SRI, published hashes per release and per signed APK (fake
   "Kithwall" APKs are a realistic threat), and bundling the web assets inside the Android app instead of
   loading the site remotely.
9. **Censorship**: second non-Cloudflare CDN for mirrors, Snowflake/WebTunnel bridges alongside Orbot, an
   offline queue for posts and messages during shutdowns.
10. **Compliance without breaking E2EE**: message franking for reports, a transparency report, and legal
    advice on Pakistan's PECA 2025 social media authority (SMPRA) before any registration decision.

## Not recommended

Server-side search and trending, marketplace, live streaming and federation: each needs the server to read
content or makes the anonymity set public. Local (on-device) search of decrypted posts is the substitute.
