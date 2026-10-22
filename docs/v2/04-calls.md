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
| Relay preference (vault, namespace `calls`) | `lib/calls/prefs.ts`, Settings → Privacy → Calls |
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
  `offer`, `answer`, `state` (mic/camera), `leave`.
- **Mesh**: each device is an endpoint `<user id>:<random per-tab id>`. On `join` everyone replies `here`.
  The lexically smaller endpoint makes the offer, so there's never glare. ICE is gathered before the SDP is
  sent ("vanilla ICE", ≤ 3 s), which means fewer messages and nothing to reorder. Audio and video
  transceivers are created up front, so turning the camera on later is a `replaceTrack`, not a
  renegotiation. On ICE failure the offerer restarts ICE once, and a peer gone for 15 s is dropped.
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
lasts 45 s, connecting 30 s. A group call carries on while anyone is connected. A busy callee replies
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
  quality bars (RTT and loss from `getStats`), encryption panel, minimise. 1:1: the remote video or avatar,
  plus a self-view picture-in-picture that you tap to move to the other corner. Groups: a grid including
  yourself. Controls: mute, camera on/off, switch camera (with two cameras), audio output (where
  `setSinkId` exists and there are several outputs), hang up.
- Minimised: a bar at the top that follows you around the app (the root layout keeps it mounted), with
  mute, hang up and tap to return.
- Logical properties throughout (RTL tested in Arabic). Tokens only, so it follows all three styles in
  light and dark. 62 `calls.*` strings in all 12 locales (machine-drafted, to be reviewed like the rest).

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

## 11. Gaps / next

- Not exercised with real Cloudflare TURN locally (no keys): relay-only behaviour with real credentials
  should be checked on production once the keys are set (the encryption panel shows "IP address hidden").
- Native (phase 5): CallKit / ConnectionService ringing and native push for calls. On the web, a phone
  with the screen off rings only through the push notification.
- Late join: someone who missed the 45 s ring can't join an ongoing group call yet (call back instead).
- Mesh limits bandwidth at 8 people with video; a future SFU would need insertable-streams frame
  encryption to stay E2EE (the frame layer is already in place).
- The conversation list preview of a call notice is the generic system line (owned by messages).
