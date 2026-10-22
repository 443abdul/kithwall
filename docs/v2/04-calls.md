# Kithwall 2: end-to-end encrypted voice and video calls

Status: implemented (phase 4) · 2026-10-21 · brief §4 "Calls", §10 "a calls signalling channel over Realtime,
with Cloudflare TURN credentials minted per call"

Voice and video calls in one-to-one chats, group chats and circle chats of up to 8 people. Calls are
end-to-end encrypted. The server and Supabase Realtime only relay opaque blobs, and Cloudflare TURN only
relays encrypted packets.

## 1. Architecture

```
 Ann's browser                       Supabase                              Ben's browser
 ───────────────                     ────────                              ─────────────
 start_call(conv, video) ─────────▶ messages: notice {kind:'call',video} ──▶ push "Ann is calling" (offline)
 sealed ring ──────────────────────▶ Realtime ring:<ben>  (private) ───────▶ incoming-call screen
 sealed join/here/offer/answer ◀──▶ Realtime call:<conv> (private) ◀──────▶ sealed join/answer/…
                                                                            call_answered(notice) → {ans:true}
 RTCPeerConnection ◀═══════ DTLS-SRTP (+ AES-GCM frames) via Cloudflare TURN (relay) ═══════▶ RTCPeerConnection
```

| Piece | Where |
|---|---|
| Migration (RPCs, Realtime policies, push trigger) | `supabase/migrations/20261025000100_calls.sql`, test `supabase/tests/calls.test.sql` |
| TURN credentials | `app/api/calls/turn/route.ts`, `lib/calls/ice.ts`, `lib/calls/turn.ts` |
| Sealed signalling (pure) | `lib/calls/signal.ts` |
| State machine (pure) | `lib/calls/machine.ts` |
| Engine (Realtime, WebRTC mesh, media, stats) | `lib/calls/engine.ts` (`calls`, `useCall()`) |
| Frame encryption | `lib/calls/e2ee.ts` + worker `public/calls-e2ee.js` |
| Safety code | `lib/calls/safety.ts` |
| Ring tones (WebAudio, no files) | `lib/calls/tones.ts` |
| Call preferences: relay, data saver, camera off (vault, namespace `calls`) | `lib/calls/prefs.ts`, Settings → Privacy → Calls |
| Low bandwidth (§11): quality controller, Opus/codec tuning (pure) | `lib/calls/quality.ts`, `lib/calls/sdp.ts`, tests `lib/calls/lowbw.test.ts` |
| UI | `components/calls/CallButtons.tsx` (chat header), `CallRoot.tsx` (mounted in `app/layout.tsx`; loads `CallRuntime.tsx` once unlocked), `CallScreens.tsx`, `CallIcon.tsx`, `styles/v2/calls.css` |
| Thread notice | `lib/messages.ts` `readNotice` (event `{kind:'call'}`), `components/messages/content.tsx` `eventLine` |
| Push | `app/api/push/dispatch/route.ts` (`kind: 'call'`), `app/api/push/_lib/push-server.ts` `describeCall`, `public/sw.js` |

## 2. TURN and IP privacy

`POST /api/calls/turn` (caller's Supabase JWT; in-memory burst limit 20/min plus `public.turn_quota()`
= 120/hour) calls Cloudflare's documented endpoint
`POST https://rtc.live.cloudflare.com/v1/turn/keys/$CLOUDFLARE_TURN_KEY_ID/credentials/generate-ice-servers`
with `Authorization: Bearer $CLOUDFLARE_TURN_API_TOKEN` and `{"ttl": 3600}`, and returns
`{iceServers, relay, ttl}`. Entries are filtered (stun:/turn:/turns: only, port 53 dropped because we
don't trickle ICE). Credentials and request details are never logged. Without the two env vars the
route returns `stun:stun.cloudflare.com:3478` only, `relay: false`, and logs once (dev log).

**"Always relay calls (hide my IP from the other person)"** is ON by default. Then
`iceTransportPolicy: 'relay'`, so only TURN candidates are used and the other person sees Cloudflare's
address, never yours. The trade-off is explained in the setting: a little more delay, and Cloudflare sees
two relay endpoints exchanging encrypted packets. When it's on but no TURN server is available (local
dev, misconfiguration), the call still connects directly and the encryption panel says so plainly
("The relay isn't available right now…").

## 3. Signalling

- **Topics** (Realtime Authorization on `realtime.messages`, broadcast only, nothing stored):
  - `call:<conversation id>`: join and send if `kw.may_join_call(conv)`, meaning an active account,
    a member or the owner of the conversation's audience, and not a blocked 1:1 chat.
  - `ring:<user id>`: only that user receives. Anyone who shares a conversation with them may send
    (`kw.shares_conversation`, which already excludes blocks).
- **Every message is an envelope** (`sealEnvelope`): encrypted under the conversation's audience key for
  the current epoch, signed with the sender's Ed25519 identity key. The header is
  `{type:'call-signal', id:<signal uuid>, author, wall:<conversation>, audience:{id, epoch}}`. On the wire:
  `{v, i, e, env}` (+ `c` = conversation id on the ring topic only). **The author is not on the wire**: the
  receiver tries the identity keys of the conversation's members (≤ 8). Inside: `{call, from:<user:device>,
  to?, ts, body}`. Receivers drop anything that fails to verify, whose `from` user isn't the signer, older
  than 90 s, or already seen (signal-id dedupe).
- **Kinds**: `ring` (with the per-call frame key), `cancel`, `join`, `here`, `probe`, `decline`, `busy`,
  `offer`, `answer`, `state` (mic/camera, plus optional `net`/`vp`/`rx`, §11), `restart` (§11), `leave`.
  Older clients ignore the optional fields and drop `restart` as malformed, so versions interoperate.
- **Mesh**: each device is an endpoint `<user id>:<random per-tab id>`. On `join` everyone replies `here`.
  The lexically smaller endpoint makes the offer, so there's never glare. ICE is gathered before the SDP is
  sent ("vanilla ICE", 3 s, or up to 12 s while there is no candidate yet: §11), which means fewer messages and nothing to reorder. Audio and video
  transceivers are created up front, so turning the camera on later is a `replaceTrack`, not a
  renegotiation. On 'disconnected' (after 2 s) or 'failed' the offerer restarts ICE with back-off, and a peer gone
  for 30 s is dropped (§11).
- **Multi-device**: if my other device sends `join` or `decline` for the call that's ringing here, this
  device stops ringing ("Answered on another device").
- Hang-up, decline and cancel go over the Realtime REST endpoint with `keepalive`, so they still arrive
  when the page is closing. `pagehide` ends a live call, and locking or signing out ends it too.

**What Realtime / the server sees**: who is connected to which `call:`/`ring:` topic (from the JWT), when,
and how big the blobs are. It doesn't see SDP, ICE candidates, IP addresses inside candidates, the frame
key, mute/camera state, who a message is from at the payload level, or the message kind. (Checked in the
browser test: the captured frames contain no `v=0`, `a=fingerprint`, `sdp`, `offer`, `ring`, `from` or
call id.)

## 4. Media encryption and verification

1. **DTLS-SRTP** (always). The DTLS certificate fingerprints are inside the SDP, which travels in signed,
   encrypted envelopes. An attacker who controls Supabase or Realtime can't swap fingerprints without
   breaking a signature. So DTLS-SRTP is authenticated end to end between the two devices, and TURN sees
   only SRTP ciphertext. With a mesh, this holds for group calls too: there is no SFU and no server ever
   decrypts media.
2. **Frame encryption** (defence in depth, where supported): `RTCRtpScriptTransform` (Chrome, Safari,
   Firefox) or legacy `createEncodedStreams`. Every encoded frame is encrypted with AES-256-GCM under
   `HKDF(callKey, "kithwall/v1/call-frame/<sender endpoint>")`. `callKey` is 32 random bytes from the
   caller, sent in the sealed `ring`. The codec header bytes (VP8 key 10, delta 3, audio 1) stay clear and
   are authenticated as AAD. VP8 is preferred. A frame that fails to authenticate is dropped, never played.
   Both ends announce support in `join`/`here`, and the layer is only used when both have it. Otherwise the
   call silently uses DTLS-SRTP alone, which is still end to end. The panel then says "Protected by
   WebRTC's end-to-end encryption…" rather than anything alarming. Debug: `localStorage['kw.calls.noFrameE2EE']='1'`
   disables the layer; `localStorage['kw.calls.debug']='1'` exposes `window.__kwCall` (engine + peer
   connections) for tests.
3. **Safety code**: 4 emoji (64-emoji list) + 6 digits =
   `SHA-256("kithwall/v1/call-safety" ‖ call id ‖ both {user id, identity key, DTLS fingerprint}, sorted)`.
   It's the same on both screens only if each side's DTLS certificate is the one the other is talking to.
   It's shown per participant in the encryption panel (shield button), with a link to the long-term safety
   number (`/u/<handle>/verify`).

## 5. Call states

`machine.ts`: idle → outgoing / incoming → connecting → active → ended (reasons: hangup, remote,
declined, busy, no-answer, missed, rejected, elsewhere, failed, no-media) → idle after 2.5 s. Ringing
lasts 45 s, connecting 30 s (45 s on 2G/3G). A group call carries on while anyone is connected. A busy callee replies
`busy`.

## 6. Ringing, push and the thread

- `public.start_call(conv, video)` (SECURITY DEFINER): a member, ≤ 8 people, rate limit 60/hour. It writes
  the notice row `{kind:'call', video}` with an empty envelope and returns its id, which is the call id.
  `public.call_answered(msg)` (a callee, within 3 min, idempotent) adds `ans:true`.
- Trigger `push_on_call` → `kw.push_enqueue('call')` → `/api/push/dispatch {kind:'call'}` →
  "Dan is calling" (or "…is calling a group conversation"). Voice vs video is not said. The push has a
  45 s TTL, high urgency and `requireInteraction`, and links to `/messages/<chat>?call=<id>`. The service
  worker skips it when a Kithwall tab is visible (that tab is already ringing). **Hidden chats** get the
  same generic "new activity" notice as any hidden-chat push (the SW matches the `/messages/<id>` path).
  In the app, an incoming call from a hidden chat that hasn't been revealed shows "Incoming call" with no
  name or picture.
- Opening the link: `CallRoot` sends a sealed `probe` on `call:<chat>`. If the caller's device is still
  calling, it rings this device again (normal incoming screen). Otherwise the chat just opens. The `?call=`
  parameter is removed from the address bar.
- The thread shows the notice as a system line: "Ann is calling…" while it rings, "Ann started a voice/
  video call." once answered, "Missed voice call from Ann." / "You called. No answer." otherwise.

## 7. UI

- Header: voice and video buttons (`CallButtons`), disabled with a reason when you're already in a call or
  the chat has more than 8 people.
- Incoming: full screen on phones (a centred panel on desktop), with the caller's avatar pulsing (off with
  reduced motion), Decline and Accept (Accept is focused; "Accept with video" for video calls). Ring:
  WebAudio chime, plus vibration after the page has been interacted with.
- In call: title, status (Calling… / Connecting… / duration / Reconnecting…, `aria-live`), connection
  quality bars (from the quality controller, with the reason: §11), "Your/Dan's connection is weak",
  encryption panel, minimise. 1:1: the remote video or avatar,
  plus a self-view picture-in-picture that you tap to move to the other corner. Groups: a grid including
  yourself. Controls: mute, camera on/off, switch camera (with two cameras), audio output (where
  `setSinkId` exists and there are several outputs), data saver (§11), hang up. A "switch to voice only?"
  banner appears on a weak connection (§11).
- Minimised: a bar at the top that follows you around the app (the root layout keeps it mounted), with
  mute, hang up and tap to return.
- Logical properties throughout (RTL tested in Arabic). Tokens only, so it follows all three styles in
  light and dark. 80 `calls.*` strings in all 12 locales (machine-drafted, to be reviewed like the rest; the 17 for §11
  were added 2026-10-22).

## 8. Threat model

| Adversary | Outcome |
|---|---|
| Supabase / Realtime operator, or someone with database access | Sees who called which conversation and when (the notice row), whether someone answered (`ans`), and who joined `call:`/`ring:` topics when. Can't read or alter signalling (sealed + signed), can't inject a fake participant (signature over a member's identity key), and can't MITM media (fingerprints are signed). Can drop or delay signalling, which is a denial of service. |
| Cloudflare TURN | Sees the two relay allocations, packet timing and sizes (it can infer voice vs video and call length). Sees no media (SRTP + frame encryption) and no identities (credentials are anonymous and short-lived). |
| The person you call (relay on) | Sees Cloudflare's address, not yours. With relay off: your IP address. |
| A former member | Removed from the audience → Realtime refuses the topic, and the key has rotated, so they can't read newer signalling. |
| Network observer | TLS to Supabase. TURN over UDP/TCP/TLS, carrying SRTP. |
| Malicious member of the conversation | Is a legitimate participant. They hold the conversation key, so they could read that conversation's signalling (the same as its messages). |
| Replay | 90 s freshness window, signal-id dedupe, call id + endpoint addressing inside the signature. |

Known limits: frame encryption uses one key per call. Someone who leaves a group call keeps the key, but
in a mesh they no longer receive anyone's media. Clear codec header bytes reveal frame type and size, as
any SRTP does. Duration isn't stored by us, but Cloudflare and Realtime could infer it.

**Metadata we store**: one notice row per call (`sender_id`, `conversation_id`, `created_at`,
`{kind:'call', video, ans?}`). It disappears with the chat's disappearing-messages timer and is deleted
with the conversation or account. No new tables or columns, so the transparency data map is unchanged
(`messages.notice` is already classified). Rate-limit counters `call`, `call_answer` and `turn` live in
`kw.rate_events` (kept 7 days).

## 9. Owner configuration

1. Cloudflare dashboard → Realtime → TURN → create a TURN key. In Vercel set **`CLOUDFLARE_TURN_KEY_ID`**
   and **`CLOUDFLARE_TURN_API_TOKEN`** (Production, and Preview if wanted). Don't expose them as
   `NEXT_PUBLIC_*`.
2. Apply the migration: `supabase db push` (or the usual deploy path) for `20261025000100_calls.sql`.
3. Push for calls needs nothing new (the same `kw.push_config` / VAPID / `PUSH_DISPATCH_SECRET`).
4. Permissions-Policy already allows `camera=(self), microphone=(self)` (`next.config.ts`). CSP needs no
   change: WebRTC ICE/TURN isn't governed by `connect-src`, the TURN API is called server-side, and the
   frame worker is same-origin (`worker-src 'self'`).

## 10. Verification (2026-10-21)

- vitest `lib/calls/calls.test.ts`: 14 tests (seal/open round trip with the author off the wire;
  non-member, forged author, wrong key, tampered id/epoch, other conversation, stale and malformed bodies;
  endpoints; every state-machine path; safety code symmetry and sensitivity; ICE filtering). Whole app:
  282 passed.
- pgTAP `calls.test.sql`: 46 tests (topic parsing, Realtime join/send/deny for call and ring topics including
  blocks and strangers, notices, the 8-person cap, call_answered rules, client edits refused, push trigger,
  privileges). Full `supabase test db`: 752 tests pass (transparency map included).
- Browser (Playwright, system Chrome, fake mic/camera, dev server :3052): 1:1 voice connects with audio
  bytes both ways; frame encryption active (RTCRtpScriptTransform: enc ≈ dec, 0 failures); mute shows on
  the other side; same safety code on both screens; closing the page ends the call for the other side; the
  minimised bar survives in-app navigation; hang-up; video (video bytes > 0), camera off → avatar → on;
  decline; cancel → missed + thread notice; captured Realtime payloads contain no SDP/ICE/kinds/sender; a
  3-person video call (mesh of 2 connections each, audio from both, frames encrypted), one leaves and the
  others continue; the push link `?call=` re-rings a live call and is inert after the call; the TURN route
  401s without a token and returns STUN only locally; the dispatch route accepts `kind:'call'`.
  Screenshots: `screens/phase4-calls-*.png` (1280; 375 in the Bold/dark style; Arabic RTL).

## 11. Low bandwidth and unstable networks

Status: implemented 2026-10-22. Written for 2G/3G, congested mobile data, satellite links, frequent network
switches and restricted networks (the brief's Pakistan / South Asia and at-risk users). Nothing here
changes what is encrypted or who can read it: the frame format, DTLS-SRTP, the sealed signalling and the
safety code are as in §3–§4, and the CSP is unchanged.

| Piece | Where |
|---|---|
| Quality controller (pure, unit-tested) | `lib/calls/quality.ts` |
| Opus SDP tuning, codec order (pure, unit-tested) | `lib/calls/sdp.ts` |
| Stats loop, sender parameters, renegotiation, ICE restarts, retries | `lib/calls/engine.ts` |
| Settings → Privacy → Calls: "Data saver for calls", "Start video calls with my camera off" | `lib/calls/prefs.ts`, `components/settings/PrivacySettings.tsx` |
| In-call data saver button, weak-connection line, "switch to voice only?" banner, paused-video note | `components/calls/CallScreens.tsx`, `CallIcon.tsx` (`saver`), `styles/v2/calls.css` |
| Tests | `lib/calls/lowbw.test.ts` (29 tests) |

### 11.1 Audio first

- **Opus tuned in the SDP we send** (`tuneOpus`): `useinbandfec=1` (a lost packet is rebuilt from the next
  one), `usedtx=1` (almost nothing is sent while you're silent), `stereo=0`, and `maxaveragebitrate`
  32000 (12000 with data saver). An SDP's fmtp says how its author wants to *receive*, so this tunes the
  other side's encoder; only the sealed copy we send is changed, never our local description (DTLS
  fingerprint, and so the safety code, untouched; an older client still gets a valid SDP).
- **Packet time**: `a=ptime:60` instead of 20 when either side is on data saver, has a poor link, or the
  controller has squeezed Opus to ≤ 12 kbps (renegotiated mid-call, at most every 10 s per peer). A third
  of the packets: at 12 kbps the per-packet costs (IP/UDP/SRTP/RTP headers, TURN framing, and our 29-byte
  frame-encryption trailer) otherwise outweigh the voice. Measured below: 63 → 20 kbps on the wire.
- **Live bitrate**: `RTCRtpSender.setParameters` sets Opus `maxBitrate` 32 → 24 → 16 → 12 → 8 kbps from the
  controller, with `priority`/`networkPriority: 'high'` (audio wins the bandwidth allocation; video 'low').
- **RED** (RFC 2198, each audio frame sent twice): negotiated in every call (Opus first, RED second) and
  switched on for the pair when the controller sees sustained loss (≥ 8 %, ≥ 15 % with data saver) and
  there is room for double audio. Chrome only sends RED when it is *first* in the negotiated audio codec
  order — `setParameters({encodings:[{codec}]})` is accepted for audio but changes nothing (checked) — so
  the offerer renegotiates with RED first (the answerer asks with a sealed `reneg {red}`), and back when
  loss clears. **Frame encryption works with RED and FEC**: the transform sees the RED payload as one
  frame, encrypts it whole and the receiver decrypts it before RED is unpacked (measured below: 0
  failures, normal playout).
- Codec lists are trimmed (`setCodecPreferences`): no G.722/PCMU/PCMA/iLBC, no AV1/H.265, so the SDP (the
  largest signalling message) is smaller.

### 11.2 Adaptive video

`QualityController` (one per peer, fed every 2 s from `getStats`: candidate-pair
`availableOutgoingBitrate` and RTT, `remote-inbound-rtp.fractionLost`, inbound loss and jitter,
`outbound-rtp.qualityLimitationReason`):

| Tier | Video | maxBitrate | Stay above | Enter above |
|---|---|---|---|---|
| 0 | 720p / 30 fps, `maintain-framerate` | 1.2 Mbps | 700 kbps | 1.3 Mbps |
| 1 | 360p / 24 fps, `maintain-framerate` | 450 kbps | 260 kbps | 550 kbps |
| 2 | 180p / 15 fps, `balanced` | 140 kbps | 90 kbps | 170 kbps |
| 3 | paused (`active: false`): voice only | — | — | — |

- Down: two bad samples (≈ 4 s) or one if dire (budget under half the tier's need, or ≥ 35 % loss). Loss
  ≥ 10 % or RTT ≥ 1 s steps down one tier; ≥ 25 % loss pauses video; a CPU-limited encoder (cheap phones)
  steps down to 180p but never pauses for CPU alone.
- Up: 4 calm samples in a row (loss < 3 %, RTT < 600 ms) with the *enter* threshold met. An upgrade that
  fails within ~6 s doubles the wait for the next one (8 → 16 → 30 samples, i.e. up to a minute); a long
  calm spell halves it again. Paused video probes 180p again after a calm spell even though the estimate
  can't grow while almost nothing is sent.
- Resolution via `scaleResolutionDownBy` from the capture height. Phones, data saver and 2G/3G capture
  360p/24 rather than 720p/30 (less CPU before the encoder even starts). Calls start at 360p (Chrome's
  estimate starts around 300 kbps) or at 180p on 2G / data saver / Save-Data.
- **Mesh** (> 2 people): each connection gets `min(its estimate, total of all estimates / peers)`, and the
  best tier is capped at 360p with 3–4 people, 180p with 5–8 (each peer is another encoder on the same
  phone and another share of the same uplink).
- **Codecs**: with frame encryption VP8 only (the worker keeps VP8's header clear; H.264/AV1 packetisers
  parse the bitstream). Without it: phones H.264 first (hardware: far less CPU and battery), then VP8,
  VP9; desktops VP8, VP9, H.264. RTX and video RED/ULPFEC are kept.
- When my video to someone is paused by the network I tell them (`state.vp`), so they show my avatar and
  "Video paused to keep the call going" instead of a frozen frame.

### 11.3 User controls

- **Settings → Privacy → Calls → "Data saver for calls"** (off by default; also on when the browser sends
  Save-Data): video starts at 180p and never goes above it, Opus ≤ 12 kbps with 60 ms packets, RED only
  under heavy loss, and I ask the others to send me 180p (`state.rx = 2`).
- **"Start video calls with my camera off"** (off by default): video calls are placed/answered with the
  camera off; turn it on in the call.
- **In-call data saver button** (gauge icon, `aria-pressed`): the same, for this call only.
- **"Weak connection — switch to voice only?"**: a calm banner after ~6 s of a weak connection (mine or
  theirs) or video paused by the network, while video is involved. "Switch to voice" turns my camera off
  and asks the others to stop sending me video (`state.rx = 3`), saving both directions; "Not now" hides
  it for the rest of the call. Turning the camera back on ends voice-only.

### 11.4 Resilience

- **ICE restart with back-off**: on `disconnected` (after a 2 s grace, it often heals) or `failed`, the
  offerer re-offers with `iceRestart` at 0/1/2/4/8/16 s until the 30 s reconnect window runs out; the call
  stays on screen as "Reconnecting…". The answerer asks for one with a sealed `restart`. On `online` and
  Network Information `change` (Wi-Fi ↔ mobile data) every peer restarts ICE at once instead of waiting
  for the old path to time out. Restart offers are sealed and signed like every other signal.
- **Vanilla ICE on slow links**: wait 3 s for gathering, or up to 12 s while no candidate exists yet (a
  TURN allocation over a slow or TCP/TLS-only link takes several round trips; relay-only calls would
  otherwise send an SDP with no candidates).
- **TURN for restrictive networks**: Cloudflare returns `turn:…:3478?transport=udp|tcp`,
  `turns:…:5349?transport=tcp`, `turn:…:80?transport=tcp` and `turns:…:443?transport=tcp` (plus :53, which
  we drop). The filter keeps TCP and TLS on 443 (unit-tested with Cloudflare's documented response), so a
  network that only lets HTTPS out still relays. "Always relay" is unchanged.
- **Signalling retries, idempotent**: handshake messages (join, here, offer, answer, restart, state) are
  retried with back-off if neither the channel nor the REST endpoint accepts them, re-sending the *same*
  sealed message (same signal id), so a copy that did arrive is dropped as a duplicate. An offer with no
  answer after 5 s (× 1.5 each time, 4 tries) is sent again; the answerer recognises the same offer and
  repeats its answer instead of renegotiating. A callee whose `join` got no reply says it again every 4 s;
  a caller rings again every 10 s while nobody has answered (callees drop repeat rings).
- Connecting is allowed 45 s instead of 30 s on 2G/3G; ringing stays 45 s.

### 11.5 Quality shown to people

- The bars on each tile come from the controller: good / fair / poor plus the reason in the label
  ("Poor connection: data getting lost", "…: low bandwidth", "long delay", "device is busy").
- A line under the call status says **"Your connection is weak"** or **"Dan's connection is weak"**.
  Mine: offline, a 2G link, a low uplink estimate on every connection, or (in groups) every connection
  losing packets. Theirs: what they report about themselves (`state.net`, from the same rules on their
  side), or their video paused on a poor link. Loss alone on a 1:1 call can't be pinned on either end, so
  then only the bars say it.

### 11.6 Signalling additions (§3)

`state` gains optional `net` (0 good, 1 fair, 2 poor), `vp` (my video to you is paused by the network) and
`rx` (best tier I want from you: 0 any, 2 smallest, 3 none). New kinds: `restart` and `reneg {red?}`.
All inside the sealed, signed envelope; Realtime still sees only `{v, i, e, env}`. Older clients ignore
the optional fields and drop the new kinds as malformed.

### 11.7 Measured (2026-10-22/23)

Local production build, Playwright + system Chrome with fake mic/camera (a continuous tone, so DTX never
kicks in; real speech is ~half silence), two accounts in a 1:1 chat, frame encryption on
(RTCRtpScriptTransform). Bitrates from `getStats` deltas: "payload" = `bytesSent` (includes the 29-byte
encryption trailer), "wire" ≈ payload + RTP headers + 38 bytes/packet (SRTP tag, UDP, IPv4).

| Case | Audio payload | Packets/s | Audio on the wire | Video |
|---|---|---|---|---|
| Voice, normal | 35.5–36.7 kbps | 50 | ≈ 62 kbps | — |
| Voice, data saver (in-call toggle → renegotiated to 60 ms) | **11.1–11.2 kbps** | 16.7 | ≈ 20 kbps | — |
| Video call start (tier 1) | 36–37 kbps | 50 | | 360p, 72–155 kbps |
| Uplink 160 kbps (synthetic) → 180p | 29.6 kbps | 50 | | 180p, 35–84 kbps |
| Uplink 45 kbps + 30 % loss (synthetic) → paused | 11.2 kbps (Opus squeezed to 12, 60 ms) | 16.7 | ≈ 20 kbps | 0 frames, 0 kbps |
| Link clears → video back by itself | | | | after 6–7 s, 41–124 kbps |
| 12 % loss (synthetic) → RED on (renegotiated in ~5 s) | 35.5 → 61–64 kbps (each frame twice) | 50 | ≈ 87 kbps | — |

- RED + frame encryption: the receiver decrypted every frame (+798 / +2595 in two runs, 0 failures),
  concealment 0.1–1 %, audio level normal; RED off again once loss cleared. Note: `getStats` keeps
  labelling the stream "opus" while RED is sent (the payload doubles; the negotiated first codec is red).
- Voice only from the banner: the other side stopped sending video (0 frames) and my camera turned off.
- Real constraint: the receiver advertised `b=AS:100` for video (test knob `kw.calls.testVideoCapKbps`,
  debug builds of a call only). Run 1: the sender's estimate showed 70–99 kbps → video paused, audio carried
  on, 180p came back within ~8 s at 25–55 kbps. Run 2: estimate pinned at 100 kbps → held at 180p,
  65–93 kbps, bars "fair: low bandwidth".
- Network toggle (`context.setOffline(true)` for 6 s, then online): the offerer restarted ICE (2 restarts),
  the call stayed active with audio both ways; an answerer-side network change sent a sealed `restart`
  and the offerer restarted ICE; the call continued.
- UI: "Your connection is weak" on the weak side, "Alice Feedtest's connection is weak" on the other, the
  banner, the paused-video note, bars "Poor connection: data getting lost".
- Regression: the phase-4 browser scripts still pass against this build (1:1 voice/video, mute, safety
  code, minimised bar, decline, missed, opaque wire; 3-person mesh, one leaves). vitest: 423 passed
  (calls: 43, of which 29 in `lowbw.test.ts`).

## 12. Gaps / next

- Not exercised with real Cloudflare TURN locally (no keys): relay-only behaviour with real credentials
  should be checked on production once the keys are set (the encryption panel shows "IP address hidden").
- Native (phase 5): CallKit / ConnectionService ringing and native push for calls. On the web, a phone
  with the screen off rings only through the push notification.
- Late join: someone who missed the 45 s ring can't join an ongoing group call yet (call back instead).
- Mesh limits bandwidth at 8 people with video; a future SFU would need insertable-streams frame
  encryption to stay E2EE (the frame layer is already in place).
- The conversation list preview of a call notice is the generic system line (owned by messages).
- Low bandwidth (§11): the controller reads the sender's bandwidth estimate, which can't see a cap the
  receiver imposes (b=AS) or a bottleneck on the far side's downlink until loss shows up; real 2G/satellite
  links weren't available, so tiers were driven by synthetic stats plus a receiver bandwidth cap. The frame
  trailer (29 bytes/frame: 12-byte IV + 16-byte tag + marker) is ~4 kbps at 60 ms packets; a counter IV
  would save 8 bytes but needs a versioned frame format. RED and ptime changes need a renegotiation (≤ one
  per 10 s). Not yet tried on Safari/Firefox (they ignore what they don't support: `networkPriority`,
  RED, `degradationPreference`).
