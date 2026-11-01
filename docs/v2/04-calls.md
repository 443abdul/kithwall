# Kithwall 2: end-to-end encrypted voice and video calls

Status: implemented (phase 4) · 2026-10-21 · speed and reliability pass 2026-10-23 (§12) · late join, in-call device picker and
lock-screen ringing in the Android app 2026-11-01 (§14) · brief §4 "Calls", §10 "a calls signalling channel over Realtime,
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
| Device choice, media errors; "Test camera and microphone" (§7, §12); in-call device picker (§14.2) | `lib/calls/devices.ts`, `components/calls/CallCheck.tsx`, `components/calls/CallDevices.tsx` |
| Late join: live-call hints, "Call in progress · Join" (§14.1) | `lib/calls/live.ts`, `components/calls/LiveCall.tsx` (chat header via `CallButtons`, list via `messages/ChatList.tsx`), tests `lib/calls/latejoin.test.ts` |
| Android incoming-call screen over the lock screen (§14.3) | `apps/mobile/android/.../IncomingCallActivity.java`, `Notifier.java`, `CallActionReceiver.java`, `KithwallPushPlugin.java` (`cancelCall`, `call` event), `lib/native/calls.ts` |
| Low bandwidth (§11): quality controller, Opus/codec tuning (pure) | `lib/calls/quality.ts`, `lib/calls/sdp.ts`, tests `lib/calls/lowbw.test.ts` |
| UI | `components/calls/CallButtons.tsx` (chat header), `CallRoot.tsx` (mounted in `app/layout.tsx`; loads `CallRuntime.tsx` once unlocked), `CallScreens.tsx`, `CallIcon.tsx`, `styles/v2/calls.css` |
| Thread notice | `lib/messages.ts` `readNotice` (event `{kind:'call'}`), `components/messages/content.tsx` `eventLine` |
| Push | `app/api/push/dispatch/route.ts` (`kind: 'call'`), `app/api/push/_lib/push-server.ts` `describeCall`, `public/sw.js` |

## 2. TURN and IP privacy

`POST /api/calls/turn` (caller's Supabase JWT; in-memory burst limit 20/min plus `public.turn_quota()`
= 120/hour) calls Cloudflare's documented endpoint
`POST https://rtc.live.cloudflare.com/v1/turn/keys/$CLOUDFLARE_TURN_KEY_ID/credentials/generate-ice-servers`
with `Authorization: Bearer $CLOUDFLARE_TURN_API_TOKEN` and `{"ttl": 3600}`, and returns
`{iceServers, relay, ttl}`. Entries are filtered (stun:/turn:/turns: only, port 53 dropped: browsers block
it) and ordered UDP → TCP → TLS. Credentials and request details are never logged. Without the two env
vars the route returns `stun:stun.cloudflare.com:3478` only, `relay: false`, and logs once (dev log). When
the keys ARE set but Cloudflare fails, it answers **503** (with the STUN list for older clients), so the
client can tell "this server has no relay" from "the relay failed just now".

The client (`lib/calls/turn.ts`) fetches the credentials **before** anyone taps Call: when a chat with
call buttons opens and when a call rings on this device; they are cached until 5 minutes before the
1-hour TTL and refreshed in the background (§12). Each fetch has a 6 s timeout.

**"Always relay calls (hide my IP from the other person)"** is ON by default. Then
`iceTransportPolicy: 'relay'`, so only TURN candidates are used and the other person sees Cloudflare's
address, never yours. The trade-off is explained in the setting: a little more delay, and Cloudflare sees
two relay endpoints exchanging encrypted packets. When the server has no TURN configured at all
(local dev, previews), the call still connects directly and the encryption panel says so plainly ("The
relay isn't available right now…"). When TURN is configured but the credentials can't be fetched
(timeout, 503, offline), the fetch is retried once and then the call **fails fast** with "Couldn't reach
the call relay" plus what to do (try again, or turn the setting off). It never hangs and never quietly
falls back to a direct connection that would show the IP address the person asked to hide. Nobody is
rung for a call that can't be relayed.

**Why "Always relay" stays ON by default (decision 2026-10-23).** The slowness people blamed on the relay
came from things that are now fixed, not from relaying itself: the credential fetch sat on the critical
path at tap time (a serverless cold start + Supabase auth + Cloudflare's API: 0.2–1.4 s locally, more on
Vercel Hobby), ICE waited for *every* candidate, including TURN-over-TCP/TLS allocations, before sending
the offer (3.1 s measured, up to 12 s), and on failure nothing said what was wrong (§12). Relaying
through Cloudflare's anycast network adds one short hop (its points of presence are near both ends,
including Karachi, Lahore and Islamabad) and is often *more* reliable on mobile carriers' CGNAT, where
direct paths fail. Turning it off by default would show every caller's IP address (roughly where they
are) to the other person, which the brief rules out for at-risk users. The trade-off stays in the
setting's description.

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
- **Kinds**: `ring` (with the per-call frame key), `ringing` (the callee's device is ringing: the caller
  shows "Ringing…"), `cancel`, `join`, `here`, `probe`, `decline`, `busy`, `offer`, `answer`, `cand`
  (trickle ICE), `state` (mic/camera, plus optional `net`/`vp`/`rx`, §11), `restart` (§11), `leave`, and
  `live` (late join, §14.1: on ring topics only).
  Older clients ignore the optional fields and drop `restart` as malformed, so versions interoperate.
- **Mesh**: each device is an endpoint `<user id>:<random per-tab id>`. On `join` everyone replies `here`.
  The lexically smaller endpoint makes the offer, so there's never glare. **Trickle ICE** (2026-10-23, §12):
  the offer and the answer are sent as soon as they exist and the candidates follow in sealed `cand`
  messages. Each `cand` carries *all* candidates gathered so far for one ICE generation (`u` = the
  sender's ice-ufrag, ≤ 64 entries of `[sdpMid, sdpMLineIndex, candidate]`, `done` once gathering
  finished), so any one supersedes the earlier ones: a lost message costs nothing and a repeat is a no-op,
  the same idempotency as every other handshake message. The first candidate goes at once, later ones in
  150 ms batches (2–4 messages per connection). Candidates that arrive before the matching description
  are kept and applied after it; ones for an old ICE generation are ignored. Trickle is used only when
  both ends announced it (`tr` in `join`/`here`/`offer`/`answer`); with an older client the offer waits
  for gathering as before ("vanilla ICE", 3 s, or up to 12 s while there is no candidate yet). The reply
  to `join` (`here`) and the offer go out together instead of one after the other. Audio and video
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
   Both ends announce support in `join`/`here`, and the layer is only used when both have it. The worker
   encrypts/decrypts frames **concurrently but passes them on in order** (≤ 16 in flight, then
   back-pressure). Processing one frame at a time queued them behind each other on a slow CPU: under 4×
   CPU throttling the receiver's audio jitter buffer reached 223–436 ms with the layer on, against
   63–143 ms without it; with the concurrent worker it is 43–74 ms, the same as without (§12). Otherwise the
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
declined, busy, no-answer, missed, rejected, elsewhere, failed, no-media, relay) → idle after 2.5 s (20 s
for endings that need reading: failed, no-media, relay; or until dismissed). While outgoing, the caller's
status follows `progress`: Calling… → Ringing… (a `ringing` arrived) → Connecting… (someone joined). Ringing
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
- In call: title, status (Calling… / Ringing… / Connecting… / duration / Reconnecting…, `aria-live`), connection
  quality bars (from the quality controller, with the reason: §11), "Your/Dan's connection is weak",
  encryption panel, minimise. 1:1: the remote video or avatar,
  plus a self-view picture-in-picture that you tap to move to the other corner. Groups: a grid including
  yourself. Controls: mute, camera on/off, switch camera (with two cameras), audio output (where
  `setSinkId` exists and there are several outputs), data saver (§11), hang up. A "switch to voice only?"
  banner appears on a weak connection (§11). Since §14 the speaker button became "Microphone, camera and
  speaker" (the device picker, §14.2).
- Errors say what happened and what to do (§12): microphone refused (how to allow it in site settings),
  missing, or used by another app; relay unreachable; couldn't connect. "Try again" (caller) and "Test
  camera and microphone" (no-media) buttons. A video call whose camera fails carries on as a voice call
  ("Your camera isn't available, so this is a voice call").
- **Test camera and microphone** (`CallCheck.tsx`, Settings → Privacy → Calls, and from a no-media
  ending): self-view, live microphone level (`role="meter"`), microphone/camera/speaker pickers, a test
  sound. Nothing is recorded or sent; the stream stops when the dialog closes. The choice is kept on this
  device (`lib/calls/devices.ts`, localStorage) and used as an `ideal` constraint (a missing device falls
  back to the default). A microphone or camera that disappears mid-call (unplugged headset, another app)
  is re-acquired by itself.
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
- Up: 4 calm samples in a row (loss < 3 %, RTT < 600 ms; the **first** step of a call needs only 2, about
  4 s) with room for the next tier: the *enter* threshold met, **or** an estimate ≥ 1.6 × what the current
  tier may send (video maxBitrate + Opus). The second rule (2026-10-23) is needed because the bandwidth
  estimate can't grow far past what the encoder is allowed to send: with 360p capped at 450 kbps it
  settled at ~830 kbps on a LAN and never reached 1.3 Mbps, so calls stayed at 360p on perfect links (and
  a call pushed down to 180p never came back to 360p). An upgrade that
  fails within ~6 s doubles the wait for the next one (8 → 16 → 30 samples, i.e. up to a minute); a long
  calm spell halves it again. Paused video probes 180p again after a calm spell even though the estimate
  can't grow while almost nothing is sent.
- Resolution via `scaleResolutionDownBy` from the capture height. Phones, data saver and 2G/3G capture
  360p/24 rather than 720p/30 (less CPU before the encoder even starts). Calls start at 360p, or at 180p on 2G / data saver /
  Save-Data, and each side asks the other's encoder to start at 800 kbps (`x-google-start-bitrate` in the
  SDP we send; not on 2G/3G, with data saver or when asking for small video) instead of Chrome's ~300 kbps.
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
- **Candidates on slow links**: with trickle ICE (§3) a slow TURN allocation (TCP/TLS-only networks) no
  longer delays the offer: its candidate simply follows when it exists. With an older client: wait 3 s
  for gathering, or up to 12 s while no candidate exists yet.
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

## 12. Speed: connected in under a second, sharp video sooner (2026-10-23)

Owner report: "calling, especially video calling, is always slow". Measured with Playwright + system
Chrome (two separate browser instances, fake camera/mic), local production build, local Supabase, two
accounts in a 1:1 chat, frame encryption on. There are no TURN keys locally (`relay: unavailable`, host
candidates), so relay-only calls could not be measured. Times are from the caller's tap; "after accept"
is from the callee's tap. Warm = 2nd and 3rd call of a session (averaged); cold = first call after the
page loaded.

**Root causes found**

1. *Vanilla ICE*: the offerer waited for ICE gathering to complete before sending the offer. Gathering
   never completed promptly (a STUN server or network interface that doesn't answer), so every call paid
   the 3 s soft cap (3.04–3.25 s between creating and receiving the offer; up to 12 s with slow TURN
   allocations). Fixed: trickle ICE (§3).
2. *Everything in series*: caller: microphone → `start_call` → TURN credentials → channel → join → ring;
   callee: microphone → TURN credentials → join. Fixed: in parallel, credentials prefetched (§2), ring as
   soon as the call notice and the key exist; the callee says `join` before its camera is ready (offers
   wait for it); `here` and the offer go out together.
3. *Video stuck at 360p*: the controller needed an estimate the browser can't produce while the encoder
   is capped (§11.2). Fixed: headroom rule, a faster first step, a higher start bitrate.
4. *The frame-encryption worker handled one frame at a time*: latency built up on slow CPUs (§4). Fixed:
   concurrent, in order.
5. *Silent failures*: no timeout on the TURN fetch; a relay failure silently went direct; microphone
   errors were one vague line. Fixed: §2, §7.
6. Checked and not a cause: Realtime latency (offer delivery 64–177 ms warm once ICE stopped waiting),
   the lazy-loaded engine (`CallButtons` already imports it with the chat; `CallRuntime` loads at
   unlock), capture constraints (720p desktop, 360p phones). Android's call audio mode is now switched by
   the engine before capture starts instead of up to 1 s later by the screen watcher.

**Before → after** (same machine and accounts; script `measure.cjs` in the session scratchpad)

| | Before | After |
|---|---|---|
| Call screen after tap | 14 ms | 31 ms (≤ 250 ms under 4× CPU throttling) |
| Callee's phone rings, warm / cold | 620 ms / 1.39 s | 486 ms / 1.07 s |
| Connected after accept, video (warm) | 3.58 s | **0.61 s** |
| First remote video frame after accept (warm) | 3.81 s | **0.94 s** |
| Connected after accept, voice (warm) | 3.40 s | **0.37 s** |
| Offer created → received | 3.10 s | 0.18 s |
| Connected after accept, video, 4× CPU throttle (warm) | 5.58 s | 2.32 s |
| Steady video (desktop, LAN) | 360p@20, never higher | 720p@17–20 within 4–8 s |
| Steady video, 4× CPU throttle | 360p → 540p@14–20 | 720p@16–20 |
| CPU per participant (whole Chrome, % of one core) | 66 % (at 360p) | 97 % (at 720p) |
| Receiver jitter buffer audio / video, 4× throttle, frame E2EE | 62–436 / 35–110 ms | 43–74 / 22–31 ms |
| Frame encryption | on, 0 failures | on, 0 failures |

Cold first calls are slower on both builds (camera start 0.4–1.7 s in a fresh browser, first use of
crypto and JIT): connected after accept went 4.5 → 3.0 s. Frame-encryption CPU cost at 360p on desktop:
66 % against 61 % of a core with the layer off (about 5 points per side); the encoder is libvpx
(software) either way on desktop.

**Frame E2EE stays on by default.** With the concurrent worker its latency cost is gone and its CPU cost
is small. VP8 stays the only codec used with frame encryption: Chrome's H.264 packetiser parses NAL units
inside the frame, so encrypting the payload breaks it unless the format keeps every NAL header clear and
escapes start-code emulation in the ciphertext (what SFrame implementations do), which is a versioned
frame-format change for another day. Most Android phones encode VP8 in hardware (Qualcomm, Exynos, recent
MediaTek), and calls without the layer (older clients) still prefer H.264 on phones. DTLS-SRTP is
already end to end for 1:1 and mesh calls and TURN only relays ciphertext, so the layer is defence in
depth, and now cheap enough to keep everywhere.

**Debug switches** (localStorage, for measurements): `kw.calls.noTrickle='1'` behaves like an older
client (vanilla ICE; trickle ↔ vanilla interop checked in both directions); `kw.calls.noFrameE2EE='1'` (§4).

## 13. Gaps / next

- Not exercised with real Cloudflare TURN locally (no keys): relay-only behaviour with real credentials
  should be checked on production. The encryption panel says "Your IP address is hidden" when the relay
  is in use; "The relay isn't available right now" means `CLOUDFLARE_TURN_*` aren't set, and then calls
  between two phones behind carrier-grade NAT may not connect at all. Production logs couldn't confirm
  whether the keys are set (Hobby keeps 1 hour of logs).
- Speed (§12) was measured on one machine over a LAN; real phones on mobile data are slower in absolute
  terms (one round trip per message), but the removed waits (3 s ICE, sequential setup, the TURN fetch)
  are the same everywhere.
- Native: iOS still rings as a time-sensitive alert (no CallKit, `05-native.md` §10). On the web, a phone
  with the screen off rings only through the push notification. Android: §14.3 (what's still missing is
  listed there).
- Late join (§14.1): a member who comes online mid-call learns about it within one keep-alive (≤ 25 s);
  opening the chat doesn't ask (that would mean joining the call topic just to look).
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

## 14. Late join, device picker, ringing on a locked Android phone (2026-11-01)

### 14.1 Late join for group calls

Someone in a group or circle chat who missed or declined the ring can join the call while it lasts.

- **Who knows a call is going on.** While a call is `active`, one participant, the *announcer* (the one
  whose endpoint sorts first among everyone connected, `live.ts isAnnouncer`, so each participant can
  tell alone and the next takes over when it leaves), sends a sealed `live {n, video, key}` to the ring
  topic of every conversation member who isn't in the call (`liveTargets`): when someone joins or
  leaves, and every 25 s (`LIVE_MS`). `n` is the number of people in the call. `key` is the call's frame
  key, which these same people already got in the ring. The last person to leave a group call sends
  `n = 0` (keepalive REST, so it also goes out from `pagehide`); a hint that isn't refreshed expires after
  65 s, so a call whose last participant vanished disappears by itself.
- **What people see.** The chat header shows "Call in progress · N people · Join" in place of the call
  buttons (just "Join" in a narrow header); the conversation list shows "Call in progress · N people"
  as the preview, with a Join button next to the row (never inside the link). Join is disabled, with the
  reason, while you're in another call or when the call has 8 people. While you're in the call, there's
  nothing to join; after you leave, the offer comes back with the next announcement.
- **Joining** (`calls.joinLive`) re-reads the conversation (you must still be a member, ≤ 8 people),
  takes the key from the hint and runs exactly what answering a ring runs (`enter()`): microphone/camera,
  relay credentials, frame encryption, the call channel and a sealed `join`. Every participant replies
  `here` and the lower endpoint makes each offer, so the newcomer connects to everyone (mesh, DTLS
  fingerprints in signed SDP, frame encryption both ways). The state machine has a `join` event (idle →
  connecting). If nobody answers the `join` within 12 s, the call had ended: "The call has already ended"
  (reason `over`). Participants refuse a `join` beyond the mesh limit.
- **Existing participants see who joined**: "Cat joined the call" / "Cat left the call" under the status
  for 5 s, announced to screen readers (also while minimised).
- **Opened from a call push** (`?call=`): the announcer now answers the `probe` by ringing again (before,
  only the caller did, so a group call whose caller had left couldn't be rejoined from the push).
- **Metadata.** No RPC, no new table, nothing stored. `call_answered` is not called for a late join (the
  call was answered already). Realtime sees more small sealed blobs on ring topics of people who share
  the conversation during a call, the same path and size class as rings; it already sees who is on the
  `call:` topic and for how long. The payload is `{v, i, e, c, env}` like a ring (unit-tested: no author,
  call id, key, kind or count on the wire). The key in a hint stays in memory, never in storage.

### 14.2 In-call device picker

"Microphone, camera and speaker" in the call controls (`CallDevices.tsx`): the microphone list, the
camera (Front / Back on phones, the device list on computers), and the speaker where `setSinkId` exists
(desktop Chrome/Edge/Firefox); in the Android app, Loudspeaker / Phone earpiece (`KithwallShell.setCallAudio`,
a headset always wins). A choice switches at once and is remembered on this device (`devices.ts`, shared
with "Test camera and microphone"; device ids never leave the device).

- Switching uses `RTCRtpSender.replaceTrack` on every connection: no renegotiation; frame encryption is a
  transform on the sender and the quality controller's limits are sender parameters, so both carry on
  untouched (video re-applies its tier for the new capture size). Phones that can't open a second
  camera or microphone while one is in use: the old one is released and the new one tried again; if that
  fails, the previous device comes back (or the call carries on without video / muted, as before).
- Devices coming and going (`devicechange`, debounced): the remembered device is used again when it
  reappears (headset plugged back in), and a device that disappeared without its track ending falls back
  to the default; a track that ends is recovered as before (§7). One device operation runs at a time.
- The switch-camera button now flips front/back on phones and cycles cameras on computers (which report no
  direction), and is remembered too.

### 14.3 Ringing when an Android phone is locked

**How call pushes reach the app (investigated).** The server sends the same `PushPayload` the service
worker gets ("Dan is calling", `kind: 'call'`, tag `call:<chat>`, link `/messages/<chat>?call=<id>`),
sealed with RFC 8291 to the app's own P-256 key; FCM carries `{kw: <ciphertext>}` (high priority, 45 s
TTL), UnifiedPush the same as Web Push. The app decrypts it natively (`PushStore.decryptOwn` /
the connector) and `Notifier` recognises a call by `kind`. So the phone recognises an incoming call
without the server or the push provider learning anything new; the provider already saw a high-priority
45 s push. Hidden chats still get only the generic "new activity" notice (no ringing), as before.

**What it does now**

- `Notifier.showCall`: a `CallStyle.forIncomingCall` notification on the `calls` channel whose ringtone
  repeats (`FLAG_INSISTENT`) until the call stops ringing. Its full-screen intent is
  `IncomingCallActivity`, a bare native screen over the lock screen (`showWhenLocked`, `turnScreenOn`, its
  own task, excluded from recents, no WebView, the app's screenshot blocking applied). On Android 14+
  without the full-screen permission (`canUseFullScreenIntent()` false) it's a high-priority heads-up
  notification with Decline and Answer actions.
- **Masked on the lock screen**: while the phone is locked with a PIN/pattern/password, both the
  notification (its public version) and the screen say only "Incoming call" / "Incoming group call",
  never who; the name appears once unlocked, as for every other lock-screen copy.
- **Answer** unlocks first (`requestDismissKeyguard`; the app itself never shows over the lock screen) and
  opens `/messages/<chat>?call=<id>&answer=1`. The page probes, the caller (or the announcer of a group
  call already going on) rings this device again, and the engine accepts that ring at once
  (`autoAnswer`, 30 s) or joins a call it already has a live hint for: straight into the call, no second
  tap. Before, the full-screen intent opened the app itself, which on a locked phone was started behind
  the keyguard and cancelled the notification on arrival, so the ringing stopped at once.
- **Decline** stops ringing. When the page is running (in the background, unlocked), the decline is
  forwarded to it (`KithwallPush` `call` event) and it sends the sealed decline, so the caller hears it
  (`declineFromPush`).
- **Stops ringing** when this device's engine stops ringing for that call (answered here or on my other
  device, declined, cancelled by the caller, timed out: the engine calls `KithwallPush.cancelCall`),
  when Answer or Decline is tapped, and when the caller's 45 s are up: the push now carries `ts` (the
  call notice's own time, already known to the server) and the notification times out at
  `ts + 45 s` (with slack for clock differences) instead of 45 s after a possibly late delivery. A repeat
  push for the same call doesn't ring twice.

**What it can't do without telling the server more, and what would be needed**

- With the app **not running** (no page, no keys in memory), Decline can only stop ringing on this phone:
  the native side holds no conversation or identity keys, so it can't send the sealed decline; the
  caller's ring times out ("No answer"). Needed: keeping signalling keys natively (a much larger key
  surface) or a server-side "declined" RPC (new metadata). Not done.
- With the app not running, a **caller's cancel** or the call being **answered on my other device** can't
  reach the phone (both travel only as sealed Realtime broadcasts); the notification then rings until the
  caller's 45 s are up. An "answered elsewhere" push would be possible without new metadata (the server
  already learns `ans` from `call_answered`), but needs a second push trigger and `push_plan` kind
  scoped to the answering user; a cancel push would tell the server when calls are cancelled. Not done.
- Play Console: *App content → Full-screen intent* must be declared ("calling app"; the permission was
  already in the manifest, `05-native.md` §9).

### 14.4 Verification (2026-11-01)

- vitest `lib/calls/latejoin.test.ts` (sealed `live` round trip with nothing readable on the wire,
  count/key validation, members only; machine `join` / `over`; one announcer and hand-over; targets; hint
  expiry and refresh; following devices), plus the existing calls tests.
- Browser (Playwright, system Chrome, fake mic/camera, dev server, local Supabase; three fresh passphrase
  accounts in one group chat, one context each, Cat at 390 px): Ann video-calls, Ben answers, Cat
  declines → Cat's list shows "Call in progress · 2 people" with Join, the header shows Join instead of
  the call buttons → Cat joins: every device has two connected peer connections with audio and video
  from both others, frame encryption (RTCRtpScriptTransform) on all three with 0 failures, Ann sees "Cat
  Latejoin joined the call" → Ann switches microphone mid-call: the audio sender track is replaced on
  both connections, the transform and the 32 kbps limit are unchanged, Ben keeps receiving and decrypting
  (0 failures), the choice is stored; a microphone track that ends is recovered on both connections and
  comes back on the remembered device → Cat leaves: the call goes on, Ben sees "… left the call", Cat is
  offered Join again → Ann hangs up, Ben is alone and the call ends; Cat's Join disappears 0.1–0.2 s later
  (`n = 0`) → every ring-topic broadcast is `{v, i, e, c, env}`; no kinds, SDP or fingerprints in any
  captured Realtime REST payload. Opening `/messages/<chat>?call=<id>&answer=1` on a device that wasn't
  ringing (the notification's Answer, app cold) gets it into the call without tapping Accept, and the
  parameters are removed from the address bar.
- Android: `compilePlayDebugJavaWithJavac` and `compileFossDebugJavaWithJavac` (JDK 21) pass. Not run
  on a device or emulator: the full-screen screen over a real lock screen, the ringtone, Answer through
  `requestDismissKeyguard`, Decline forwarding and the Android 14 fallback still need a phone (with FCM
  or a UnifiedPush distributor).
- Not verified: the device picker with several real microphones/cameras/speakers (the fake devices give
  one camera; the picker hides lists with a single entry), front/back switching on a phone, Safari/Firefox.
