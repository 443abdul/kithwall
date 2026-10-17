# Kithwall — 02 · Scope

Everything in the 2010 reference is in scope. This document lists each feature, what changes
for privacy, and which release it lands in. Anything not listed here is out of scope.

Legend: **Keep** = same as 2010 · **Adapt** = same experience, different mechanics for privacy ·
**Drop** = removed on purpose (reason given).

## 1. Feature inventory (all 36 screens of the 2010 reference)

### Accounts & identity
| 2010 feature | Kithwall | Release |
|---|---|---|
| Splash + sign-up ("It's free, and always will be") | **Adapt** — same look; sign-up also creates encryption keys and shows the 24-word recovery key | R1 |
| Login (fields in the header) | **Keep** — password never leaves the device in usable form | R1 |
| Forgot password | **Adapt** — email reset **plus** recovery key or trusted friends; without them encrypted content is unrecoverable (stated up front) | R1 |
| Trusted-friend recovery | **New** — choose 3–5 friends; any 2 (configurable) can help you back in | R1 |
| Account settings | **Keep** + change password, MFA (authenticator app), active sessions, recovery setup | R1 |
| Privacy settings grid | **Adapt** — see §2 | R1 |
| Data export ("Download Your Information", added 2010) | **Keep** — decrypted on-device into a ZIP | R1 |
| Delete account | **Keep** — real, immediate deletion + crypto-shredding | R1 |

### Profile & friends
| 2010 feature | Kithwall | Release |
|---|---|---|
| Profile (Dec 2010 design: info strip, 5 tagged photos, left nav) | **Keep** | R1 |
| Info page (Education & Work, Basic Info, Likes, Contact, Philosophy, Arts, Sports) | **Keep** — encrypted to the chosen audience | R1 |
| Edit profile (all tabs) | **Keep** | R1 |
| Profile picture | **Keep** — choose friends-only or public | R1 |
| Friends list, mutual friends | **Keep** | R1 |
| Friend requests (jewel, accept/ignore inline) | **Keep** | R1 |
| People You May Know | **Adapt** — computed on your device from friends who share their friend lists with you; no server-side graph mining | R2 |
| Pokes | **Keep** | R1 |
| Relationship status ("In a relationship with …") | **Keep** — linked partner must confirm | R1 |
| Friend lists (custom audiences) | **Keep** — each list has its own key | R2 |
| Block | **Keep** — enforced by the database | R1 |

### Sharing
| 2010 feature | Kithwall | Release |
|---|---|---|
| Publisher: Status · Photo · Link · Video · Question | **Keep** (Video in R3) | R1 / R3 |
| Wall + wall-to-wall | **Keep** | R1 |
| Like · Comment · Share; like comments; "View all N comments" | **Keep**; Share limited to public posts and links (re-sharing a friends-only post would leak it) | R1 |
| News Feed: Top News · Most Recent | **Adapt** — "Top News" ranked on your device (likes, comments, closeness); no server algorithm | R1 |
| Link previews | **Adapt** — fetched through a no-log proxy so friends' IPs aren't sent to the linked site; preview encrypted with the post | R2 |
| Notes | **Keep** | R2 |
| Questions (polls) | **Keep** — votes encrypted, tallied by readers' devices | R2 |
| Places check-ins ("was at Main Quad — with Kevin") | **Keep** — encrypted; location only when you press Check In, never in the background | R2 |

### Photos
| 2010 feature | Kithwall | Release |
|---|---|---|
| Albums, upload, photo viewer, prev/next | **Keep** — encrypted on device; location/camera metadata (EXIF) stripped before upload | R1 |
| Tags ("In this photo") + tag approval | **Keep** — tagged friend is notified; tags are encrypted | R1 |
| Photo comments & likes | **Keep** | R1 |

### Communication
| 2010 feature | Kithwall | Release |
|---|---|---|
| Messages (threaded conversations) | **Keep** — end-to-end encrypted | R1 |
| Chat (bottom-right bar, buddy list, docked windows) | **Keep** — same conversations as Messages (as in Nov 2010); "online" status can be turned off | R1 |
| Notifications jewel + "See All" | **Keep** — notification text encrypted to the recipient | R1 |
| Email notifications | **Adapt** — content-free ("You have a new notification") | R2 |

### Community
| 2010 feature | Kithwall | Release |
|---|---|---|
| Groups (Oct 2010: Open / Closed / Secret, group feed, members, docs) | **Keep** — Closed/Secret groups encrypted to members; Open groups public | R2 |
| Events (create, invite, RSVP, guest lists, event wall) | **Keep** — private events encrypted to invitees | R2 |
| Pages (Like, page wall, fan count) | **Adapt** — pages are public by nature; **which pages you like is private by default** | R2 |
| Search | **Adapt** — people search only finds those who opt into the directory; your own content is searched on your device | R1 |
| Invite friends | **Adapt** — share an invite link; we never upload or store your address book | R1 |
| Help center | **Keep** | R1 |
| AssVille game (renamed **Kithville**) | **Keep** — game state encrypted in your vault | R3 |
| Apps page | **Adapt** — first-party only (Kithville, Questions, Notes); no third-party data access | R3 |

### Dropped on purpose
| 2010 feature | Why |
|---|---|
| Sponsored ads | No ads, ever. The ad slot shows Kithwall tips or nothing |
| Third-party app platform | Third-party apps reading friends' data is exactly what we're avoiding |
| "Friends of Friends" audience | Can't be end-to-end encrypted without handing keys to people the author never chose. Replaced by Friends / Custom lists / Public |
| Contact importer (upload address book) | Uploads other people's data without their consent |
| Facial recognition tag suggestions | Biometric processing; out of character for the product |

## 2. Audiences (replaces the 2010 privacy grid values)

| Audience | Encrypted? | Notes |
|---|---|---|
| **Only Me** | Yes | Drafts, private photos |
| **Friends** (default) | Yes | Your current friends |
| **Custom** (friend lists or specific people) | Yes | "Close Friends", "Family", etc. |
| **Public** | **No** — marked with a globe and "not encrypted" | Needed for public profiles, Pages, Open Groups, public events |

## 3. Releases

| Release | Contents | Exit criteria |
|---|---|---|
| **R0 Foundation** | Repo, CI, Supabase project, schema + RLS, crypto package with test vectors, design tokens, app shell | CI green; RLS tests pass; crypto vectors pass |
| **R1 Core social** | Sign-up/login/recovery (key + trusted friends), profile, friends, pokes, blocks, wall & feed with likes/comments/share, photos with tags, messages & chat, notifications, privacy, account, export, delete, responsive layouts | Two real users can befriend, post, comment, share photos and chat; server-side inspection shows only ciphertext |
| **R2 Community** | Groups, events, pages, notes, questions, places, friend lists, People You May Know, link previews, email notifications, moderation tools | All 2010 screens reachable and working |
| **R3 Extras & hardening** | Kithville, video, passkeys, safety-number verification, forward-secret messaging (MLS), independent security review | External review findings resolved |

## 4. Non-goals
Native iOS/Android apps (the web app is installable as a PWA), ads, creator/influencer tools,
algorithmic recommendations of strangers, cryptocurrency, AI features that read user content.

## 5. Constraints & assumptions
- Hosting on Vercel (web) and Supabase (data); the owner connects Vercel to the GitHub repo.
- Browser support: last 2 versions of Chrome, Edge, Firefox, Safari (iOS 16+). WebCrypto and
  WebAssembly required.
- A user's posts can only be delivered to a new friend once one of the author's devices comes
  online (keys are shared device-to-device). The UI explains this when it happens.
