# Kithwall 2: reels

Status: implemented · 2026-11-11 · migration `supabase/migrations/20261112000300_reels.sql` ·
tests `supabase/tests/reels.test.sql`, `apps/web/src/lib/reels/*.test.ts`

Short vertical videos: the "scroll and stay" surface people expect from a social app. Every other app pays
for that surface by watching the watcher. Kithwall's version keeps the rule the rest of the product follows:

> The server stores reels and hands out lists of them. It is never told what anyone watched, for how long,
> what they skipped or what they came back to. The feed is ordered on the person's own device, from a
> profile that never leaves it.

Builds on `10-follow-public.md` (follow, Followers posts, Public posts, Explore).

## 1. What a reel is

A reel is a **post of kind `reel`**: one video of at most 60 seconds, a cover picture and a caption. It adds
no table and no column. Everything a post has, a reel has:

| | |
|---|---|
| Audience | Public, Followers (accounts with follow on), Connections, Close friends, a circle, Only me: the same picker as the post composer, the same rules in the database |
| Encryption | Non-public reels are sealed like any post; the video and cover are encrypted files in the private `media` bucket. A Public reel is signed, not encrypted, and labelled Public; its files stay encrypted objects whose keys are in the readable post, exactly like a public post with a video |
| Comments, likes, mentions, "who can comment" | The existing ones. On a Public reel they are public, as on any public post |
| Reports, automatic hiding after reports, moderators, blocks, restrictions | Unchanged, because a reel is a post (`10-follow-public.md` §7) |
| Link | A Public reel opens at `/p/<id>` without an account |
| Home feed and profile | A reel also shows as a post with a video in the Home feed of the people who can read it and on its author's profile |
| Export | In the data export with the author's other posts; the video file is included |

A reel goes on its author's own profile or into a circle; not onto someone else's profile, not into an
event, and it is not a repost (`kw.posts_reel_guard`).

## 2. Making a reel

From the post composer (the reel button) and from "New reel" in Explore → Reels and in the reels screen
(`components/reels/ReelComposer.tsx`).

1. **Pick a video** (MP4, MOV, WebM; up to 1 GB, it never leaves the device as it is) **or record one in the
   app** (camera and microphone through `getUserMedia` + `MediaRecorder`, up to 60 seconds, front or back
   camera). Where the browser offers no camera, "Open the camera app" uses the system camera instead.
2. **Trim**: a start and an end slider; the selection is at most 60 seconds and at least one.
3. **Cover**: a slider picks the frame; it is saved as a JPEG of at most 720 px on the short side.
4. **Caption** (up to 2,200 characters; `#topics` and `@mentions` work as in posts).
5. **Who sees it**: the audience picker of the post composer. Public and Followers appear only when the
   account lets people follow it; before the first public post the "Public means anyone" sheet is shown.
6. **Share**: the video is re-encoded on the device, then encrypted and uploaded, with a progress bar and a
   Cancel button at every stage. Cancelling removes whatever was already uploaded.

### Encoding (`lib/reels/transcode.ts`, numbers in `lib/reels/plan.ts`)

| | Normal | Data Saver |
|---|---|---|
| Picture | at most 720p (720 on the short side, 1280 on the long side; never scaled up), 30 frames a second | at most 540p |
| Video bitrate | 850 kbit/s at 720p, less for smaller pictures, constant bitrate | 500 kbit/s |
| Sound | 96 kbit/s stereo | 64 kbit/s |
| Size | **about 7 MB per minute** (target range 5 to 8) | about 4.5 MB per minute |

How it is done: the browser's own `<video>` element plays the source from the trim start to the trim end
(so everything the device can play works, phone rotation included), each frame is drawn scaled onto a
canvas, and the sound is routed through Web Audio instead of the speakers. Then, depending on the device:

1. **WebCodecs** (Chrome, Edge, the Android app's WebView): `VideoEncoder` (H.264; VP9 where there is no
   H.264 encoder) and `AudioEncoder` (AAC, else Opus) with exact timestamps, written as an MP4 by
   **mp4-muxer**.
2. **MediaRecorder** (Firefox, Safari, anything without the full WebCodecs set): the canvas and the sound
   are recorded as the browser's own MP4 or WebM at the same target bitrate.
3. **Neither**: the original file is uploaded only if it is already a whole MP4 or WebM of at most 60
   seconds within the size cap, and the screen says that it goes up as it is, "with any details the camera
   saved in it". Otherwise the screen says what to pick instead. Nothing is uploaded silently.

The bitrate is a target the browser's encoder aims at, not a guarantee. Measured with Chrome's software
H.264 encoder (§11): a camera-like 30 frames-a-second clip came out at 6.8 MB per minute; a clip made of
full-frame random noise, which no encoder can compress, came out at about 15 MB per minute. That is why
there is a hard cap: if the result is larger than the cap, it is encoded once more at a lower bitrate; if it
is still too large, the person is told to pick a shorter part.

Re-encoding also removes what the camera wrote into the file (place, device, time), as photo uploads
already do.

**Honest limit: it takes as long as the reel is.** Playing the source once is real time, so a 30-second
reel is ready in about 30 seconds, and the screen has to stay open (the work pauses while the app is in the
background and continues after). Faster-than-real-time encoding needs a demuxer for every input format; see
§9.

**The one new dependency: `mp4-muxer` 5.2.2** (MIT, about 20 kB minified, pure TypeScript, no network
access, no runtime dependencies; its two `@types/*` dependencies are type declarations only). It writes the
MP4 container around the frames the browser's own encoders produce. Loaded only when someone makes a reel.

### Limits, enforced by the database

| Limit | Default | Where |
|---|---|---|
| Reels per account per day | 10 (`app_settings.reel_daily_limit`, 1 to 200) | `kw.posts_reel_guard` → `kw.rate_limit('reel', …)` |
| Size of a reel's files together (video + cover), as stored | 16 MB (`app_settings.reel_max_mb`, 1 to 30) | `kw.media_reel_guard` on `media_objects` |
| Files per reel | 3 | same |
| Operator switch | on (`app_settings.reels_enabled`) | `kw.posts_reel_guard` |

The size is the one **the storage service recorded** for each file, not the size the app claimed, and a file
can only be linked to a reel once it is stored. A file that belongs to a reel cannot be replaced under the
same name (`"a reel's files cannot be replaced"`, a restrictive storage policy), so the cap cannot be got
around by swapping the file afterwards. The general limits still apply as well (300 posts and 20 public
posts a day, 3,000 uploads a day, 10 GiB per account). Operator settings: Admin → Operator settings.

Data Saver: the maker says how large the upload will be before it starts, with a warning when Data Saver is
on or the browser reports mobile data, and encodes smaller (table above).

## 3. Watching

`/reels` (`components/reels/ReelsScreen.tsx`): a full-screen vertical feed, one reel per screen, snapping
from one to the next. The app's bars are not drawn on this screen.

- **Plays by itself when on screen, muted.** The first tap on the video (or the sound button) turns sound on,
  and it stays on for the visit. Tap: pause / play. Double tap: like. A thin progress bar runs along the
  bottom. The video loops.
- **Pauses** when another reel is on screen, when a sheet or a time screen is over it, and when the app goes
  to the background.
- **Only the next reel is fetched ahead**; the one just left stays in memory, so going back does not fetch
  it again. With Data Saver nothing is fetched ahead and nothing plays by itself: the cover and a play button
  with the file size are shown.
- Over the video: the author (with **Follow** for public reels of people one neither follows nor is
  connected to), the caption with "Read more", the audience label (Public, or the padlocked audience), and
  like / comment / share / sound / more. Comments open the existing thread in a sheet. Share gives the public
  link for a Public reel (the system share sheet where there is one) and the usual repost sheet otherwise.
  "More" has **Not interested**, the link, and **Report**.
- **Accessibility.** Every control is a real button with a name; the feed is a `feed` of `article`s and only
  the reel on screen can be tabbed into. Keys: ↓ / Page Down / J next, ↑ / Page Up / K previous, M sound,
  L like. A click that comes from the keyboard or from assistive technology only plays or pauses: **sound
  never starts unless it is asked for** with the sound button. With "reduce motion" a reel is fetched but
  waits for a tap, scrolling between reels does not animate, and the like animation is not shown.
- **Android app.** The hardware Back button closes an open sheet (comments, more, report) first and leaves
  reels on the next press (a history entry while a sheet is open, as the photo gallery does).
- Works from 320 px wide, in right-to-left languages (the action rail moves to the left), in light and dark.
  The stage is dark in every style, like the story viewer.

**Where it lives.** A **Reels tab in Explore** (covers of popular public reels, "Watch reels", "New reel")
and a **shelf on Home** under the composer (covers of reels by people one follows, "Watch reels"). There is
no seventh item in the main navigation: six are as many as fit on a phone.

## 4. The feed is ranked on the device

### What is fetched

Three plain lists, each in pages of 24, the same page size for everyone and for every page:

| List | Function | What it depends on |
|---|---|---|
| Reels by people I follow, my connections and my circles, newest first | `reel_feed(p_before, p_limit)` | who I follow and am connected to (which the server already stores) |
| Public reels, popular | `explore_posts('popular', '{reel}')` | public likes, comments and age only; the same list for everyone |
| Public reels, newest | `explore_posts('recent', '{reel}')` | time only |

With each page comes one query for "which of these did I already like" and one for the kind of audience of
the encrypted ones. The next page of every list is asked for when fewer than five unseen reels are left.
Nothing in any request says which reel is on screen.

### How the order is decided (`lib/reels/rank.ts`)

The device keeps a small **interest profile**:

| It remembers | From |
|---|---|
| a score per author | watched to the end (+1), replayed (+1.5), liked (+2), commented or shared (+1.5), followed (+3), left within two seconds or before 15% (−0.6), "Not interested" (−4) |
| a score per topic (the `#hashtags` of captions) | the same signals, smaller weights |
| a score per language | the same signals, small weights |
| which reels were shown (up to 800) and which were marked "Not interested" (up to 300) | so they are not queued again |

Scores halve every three weeks. A reel's place in the queue is: how new it is, plus how popular it is in
public, plus what the profile says about its author, its topics and its language (a reel carries the
two-letter language its author's app was in; without it the script of the caption is used), plus a small
shuffle that changes from visit to visit.

The queue: two reels from people I follow, then one discovered reel, and so on. When the followed reels run
out there is a **"You're all caught up"** card, and public reels continue after it. Among discovered reels,
every fourth place goes to the best reel by newness and popularity alone, whatever the profile says, so the
feed does not close in on itself. What is already on screen (and the next reel, already fetched) is never
reordered; everything after it is ranked again each time the person moves on.

Hidden words apply to captions (a matching reel is left out), muted people are left out, blocked people
never arrive from the server.

### Where the profile lives (`lib/reels/store.ts`)

One record per account in **IndexedDB on the device** (`kw-reels`), encrypted with the vault key (derived
from the account key, so it opens only after a real unlock) and bound to the account id. It is **not** in
the encrypted vault that syncs between devices and is **never uploaded**: the file that owns it makes no
network request. Each device learns by itself.

- **Settings → Reels → "Reset what reels has learned"** empties it.
- Signing out and the panic wipe delete it.
- The data export includes it as `data/reels-on-this-device.json`, read from the device, with a note that
  it exists nowhere else.

### What the server learns, and what it does not

| The server | |
|---|---|
| **Never receives** | views, impressions, watch time, skips, replays, "Not interested", the profile, the order of anyone's queue, the time settings or the watch time of the day. There is no endpoint, table, column or function for any of it (`reels.test.sql` asserts that none exists) |
| Stores, as for any post | that an account posted a reel and when, its audience, its ciphertext (or, for a Public reel, its readable signed content), the size of its files; likes and comments on it (public ones are public) |
| Counts for spam limits | how many reels an account posted today (`kw.rate_events`, kept 7 days) |
| Sees while someone watches | **which media files an account (and IP address) downloads, and when.** This is true of every photo and video on Kithwall and cannot be avoided while the server stores the files: fetching a reel's video tells the storage service that this account fetched that file. From the order and timing of those downloads an operator who set out to do so could estimate what was watched and roughly for how long. Kithwall does not log or analyse this, and storage access logs are kept short (`03-transparency.md`), but it is not hidden by cryptography |
| Sees when asked | opening the comments of a reel fetches them; liking, commenting, following and reporting are requests like anywhere else; opening the feed on one particular reel (from a cover, the Home shelf or a link) fetches that reel by its id |

What reduces the download trail: lists are fetched in whole pages unrelated to the ranking; the next reel is
fetched ahead, so the server does not see the moment of moving on, only that a file was fetched at some
point before; "liked before?" is asked once per page, not per reel; links over a reel (the author, covers,
@mentions) are not prefetched, so the web server is not asked for an author's profile because their reel
came up; with Data Saver nothing is fetched without a tap. What would hide it further (fetching through a relay that strips the account, or padding
with decoy downloads) costs data or infrastructure and is not done (§9).

Threats considered:

| Threat | Outcome |
|---|---|
| Server builds a watch profile from events | It gets none. Only media downloads are visible (above) |
| Server reads the on-device profile | Not uploaded; encrypted at rest on the device |
| Server reorders the feed to steer someone | It can only reorder the three generic lists for everyone at once (and popular is recomputable from public counts); the personal part of the order is computed on the device |
| Server reads a Followers / Connections / circle reel | No: sealed like any post; the files are encrypted |
| Oversized uploads through reels | Size measured by the storage service, files locked once linked, daily limit |
| A reel used for harassment or spam | Reports, automatic hiding of reported public reels, moderators, blocks, 24-hour wait for public posting, daily limit |

## 5. Time controls (`lib/reels/time.ts`)

Per person, on the device, **off by default**. Settings → Reels.

- **Daily limit for reels**: off, 15, 30, 45 or 60 minutes. When the day's watch time reaches it, reels pause
  under a calm screen: "You've reached the limit you set", with "Keep watching today" (it then stays away
  until the next day) and "Leave reels".
- **Remind me to take a break**: off, or every 10, 20 or 30 minutes of one sitting: "Time for a break?".

Only time during which a reel was actually playing is counted. The count and both settings are part of the
on-device record of §4: never uploaded, not shared between devices.

## 6. Safety

Nothing new was needed, by design:

- Report from "More" → the existing report flow (the reporter's device discloses what it saw to moderators;
  a public reel reaches them as verified plain content). A Public reel is hidden once
  `public_report_hide_threshold` accounts reported it, until a moderator reviews it; its video stops being
  fetchable at the same moment.
- A block cuts reels both ways (lists, the post, the video file). Restricted people's comments are shown
  only to them and the author. "Who can comment" applies.
- Hidden words apply to captions; muted people are left out; "Not interested" is one tap.

## 7. Files

| | |
|---|---|
| `supabase/migrations/20261112000300_reels.sql` | kind `reel`, settings, `kw.posts_reel_guard`, `kw.media_reel_guard`, storage policy, `reel_feed`, reserved handles `reel`, `reels` |
| `apps/web/src/lib/reels/rank.ts` | profile, signals, scoring, queue (pure, tested) |
| `…/lib/reels/time.ts`, `plan.ts` | time controls; encode targets, trim, caps (pure, tested) |
| `…/lib/reels/store.ts` | the on-device encrypted record |
| `…/lib/reels/transcode.ts` | re-encoding (WebCodecs → MediaRecorder) |
| `…/lib/reels/data.ts` | fetch lists, open a reel, publish |
| `…/components/reels/ReelsScreen.tsx`, `ReelSlide.tsx`, `useReelFeed.ts`, `hooks.ts` | the feed |
| `…/components/reels/ReelComposer.tsx` | making a reel, recording |
| `…/components/reels/ReelsTab.tsx` | Explore tab and Home shelf |
| `…/components/reels/ReelsSettings.tsx` | Settings → Reels |
| `…/styles/v2/reels.css` | styles |

## 8. Costs, for the owner

Per reel, as stored (ciphertext is the same size as the video plus 0.03%):

| Reel | Stored |
|---|---|
| 15 seconds | about 1.8 MB |
| 30 seconds | about 3.6 MB |
| 60 seconds | about 7.2 MB, plus a cover of about 0.1 MB |
| the most the database accepts | 16 MB (operator setting) |

Per account, at the default limit of 10 reels a day, the worst case is 160 MB a day; a person who posts one
30-second reel a day adds about 110 MB a month.

Traffic: each view downloads the whole file once per visit (the feed keeps the playing reel and its
neighbours in memory and re-fetches a reel only if it is scrolled far away and back). A 30-second reel
watched 1,000 times is about 3.6 GB of egress.

At Supabase's list prices at the time of writing (check the current price page): storage beyond the plan's
quota about $0.021 per GB a month, egress beyond the quota about $0.09 per GB. So 1,000 stored 30-second
reels cost about $0.08 a month to keep, and every 1,000 views of one cost about $0.32 once the included
egress is used up. **Egress is the cost that grows with success**, not storage. Levers, in order: lower
`reel_max_mb` and `reel_daily_limit`; turn `reels_enabled` off; put a caching CDN in front of the media
bucket for Public reels only (their files are safe to cache: ciphertext whose key is public anyway);
and, if mirrors proxy storage through the web app (`08-censorship.md`), that traffic also counts on the
web host.

Reels deleted by their authors, and expired or removed posts, free their files through the existing media
trash (`docs/deploy.md`).

## 9. Not in this round

- **Faster-than-real-time encoding.** Needs a demuxer per input format (MP4/MOV and WebM/MKV) feeding
  `VideoDecoder` directly; the libraries that do this well are larger and not all permissively licensed.
  The seam is `encodeReel()` in `lib/reels/transcode.ts`: a third method can be tried before the two that
  exist.
- **Hiding the download trail** (§4): a relay that strips the account from media requests for Public
  reels, or decoy downloads.
- **Streaming playback.** A reel is fetched and decrypted whole before it plays (at most 16 MB, typically
  2 to 7). Chunked playback through Media Source Extensions would start sooner on slow links.
- Filters, music, text overlays, duets, drafts of unfinished reels, and a waiting outbox for reels made
  offline (a reel is too large to keep in the offline outbox, like post videos).
- Sound-on by default is deliberately not offered.
- Translations of the new strings (`reels.*`, `explore.tab.reels`, `mod.reel*` in
  `i18n/messages/en.json`).

## 10. Production

1. Check that no account uses the handle `reels` or `reel` (the route `/reels` would shadow its profile):
   `select username from profiles where username in ('reel', 'reels');`
2. `supabase db push` (one migration, `20261112000300_reels.sql`; adds no table and rewrites no data; the
   `posts.kind` constraint is re-validated, which reads the posts table once).
3. No new environment variables.
4. Operator settings (Admin → Operator settings): *Reels* (on), *Reels per account per day* (10),
   *Largest reel, in MB* (16).
5. Deploy the web app. The Android app needs no new build: it loads the site, and its WebView has
   WebCodecs (minimum WebView 100).
6. Before announcing: translate the new strings, and add reels to the Privacy Policy (what is stored for a
   reel, that the feed is ordered on the device, and the honest note on media downloads from §4) and to the
   Community Standards.

## 11. Verified (2026-11-11)

Headless Chrome through Playwright against the local stack, phone-sized window unless noted; the unit and
database tests listed at the top.

| | Saw |
|---|---|
| Public reel | made from Explore → Reels → New reel; stored as a signed, readable post of kind `reel`; opens at `/p/<id>` without an account |
| Followers reel | made from the Home composer; stored as ciphertext (no readable body); it is decrypted and queued on the follower's device after the author's device handed over the key. An "Only me" reel (encrypted the same way) was played back by its author |
| Re-encode, 30 fps source | 1080 × 1920, 20 s, 15.1 MB (H.264 + Opus) → **720 × 1280, 28 frames a second, 2.28 MB = 6.8 MB per minute** (H.264 + AAC in MP4, WebCodecs path), made and uploaded in 22 s |
| Re-encode, noise source | 1080 × 1920 full-frame random noise, 3 s trims → 720 × 1280, 0.70 to 0.80 MB (about 15 MB per minute: incompressible; bounded by the cap and the second pass) |
| Data Saver encode | the same source → 540 × 960, with the size warning shown before upload |
| Without WebCodecs | with `VideoEncoder` removed from the page: 720 × 1280 MP4 from the MediaRecorder path |
| With neither | with `VideoEncoder` and `MediaRecorder` removed: the maker says so at once; a whole 20 s, 15.8 MB MP4 went up unchanged with the "as it is" note; the same file trimmed was refused with the reason |
| Recording in the app | Chrome's stand-in camera: record 3.7 s, stop, trim / cover / caption, shared as a re-encoded reel |
| Cancel | during encoding: back to the editor, no post and no stored file left behind |
| Watching | first reel plays muted; a keyboard activation pauses and leaves sound off; first tap turns sound on; next tap pauses; double tap likes (a `likes` row); comment sheet posts a comment; Back closes the sheet and stays in reels; background pauses; loop; only one video plays; "You're all caught up" after the followed reels, public reels after it |
| Ranking | after leaving one author's reel within a second and watching another author's reel twice and liking it, the second author's other reel is queued before the first author's newer ones; seen reels are not queued again; the profile is one encrypted record in IndexedDB |
| Network | a visit that goes straight to `/reels`: `reel_feed` ×1, `explore_posts` ×2, likes-of-mine ×1, audience kinds ×1, the follow and connection lists ×1 each, one storage GET per cover and per video (the one playing and the next), plus the app's usual start-up reads. Walking the whole queue adds only storage GETs. No request for a view, impression or watch time exists; the only writes were the like, the comment and their notifications |
| Time controls | off by default; survive a reload; "Time for a break?" after 10 minutes of one sitting; "You've reached the limit you set" at 15 minutes, dismissed for the day with "Keep watching today" (playback time was simulated by feeding the player's time events) |
| Data Saver watching | no video request before the tap (covers only), the play button shows the size, the next reel is not fetched ahead |
| Layout | 320 px wide: nothing outside the screen, action buttons 48 px; dark mode; Urdu (right-to-left): rail on the left, author on the right; "reduce motion": waits for a tap |
| Production build | strict CSP and Trusted Types: making (WebCodecs + the `mp4-muxer` chunk) and watching a reel raised no violation. The first production run showed Next.js prefetching the profile page of each reel's author (a request per reel to the web server); those links are now `prefetch={false}` and the request is gone |

Not exercised on real hardware: an Android phone (the WebView path is the same Chromium code as the Chrome
used here, but encoder speed on a cheap phone was not measured), Safari and Firefox (their MediaRecorder
was not run; the fallback path itself was run in Chrome), and recording with a real camera.
