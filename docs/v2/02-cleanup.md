# Kithwall 2: retiring the v1 app

Status: done (end of phase 2) · 2026-10-21; §4 completed 2026-10-23 (fresh start: the classic tables were dropped
instead of exported, `supabase/migrations/20261030000100_drop_classic.sql`) · see also `00-brief.md` §4 "Dropped" and §10

The 2010-style app (`src/app/(classic)`) is gone from `apps/web`. It lives on as **Classicbook**
(`v1-classic` tag). Everything a Kithwall 2 user still needs from it was ported to the v2 design
system and translated into the 12 launch languages; the rest was deleted. At the time no database table
was dropped; that happened on 2026-10-23, when Kithwall chose a fresh start over a cutover (see §4).

## 1. Ported to Kithwall 2

| v1 | Kithwall 2 | Notes |
|---|---|---|
| `/legal/{privacy,terms,community,law-enforcement}` | `(public)/legal/[doc]` | Public header/footer from the landing page. The documents stay in English (`src/content/legal/*.md`); the page around them is translated, with a note outside English. |
| `/help` | `(public)/help` | Rewritten for Kithwall 2 (passkeys, recovery, connections, circles, stories, notes, safety defaults). Questions and answers are i18n messages (`help.*`), structure in `src/content/help.ts`. Pokes, games, pages, questions, places and the Wall are gone from it. |
| `/recover` | `(public)/recover` | Starts from the **@handle** (01-accounts.md §3 "Recovering an account"). The v1 email link and `/recover/reset` were removed on 2026-10-23. |
| `/welcome` (first login without keys) | `(auth)/setup` | Now only sessions still waiting for the 6-digit code (v1 key creation removed 2026-10-23). `/welcome` itself redirects to `/join`. |
| `/mod` | `(app)/mod` | Reports queue with verified disclosures, decisions, staff appointment, operator settings (sign-ups, the Public audience, the recovery waiting period). Same RPCs and RLS. Linked from You for staff. |
| `/post/[id]` | `(app)/post/[id]` | One `PostCard` with comments open. Activity lines and push notifications about posts and comments now lead here. |
| Account notices in the v1 header | `components/shell/AccountNotices.tsx` | Recovery requests for my account (with cancel), friends asking for help, cancelled deletions, moderation decisions. |
| `/circles/events/**`, `/circles/notes/**` (phase-2 circles stream) | `/events/**`, `/notes/**` | Moved now that the v1 routes are free; old paths redirect. |

## 2. Redirects (`apps/web/next.config.ts`, all 307)

| From | To |
|---|---|
| `/login` | `/signin` |
| `/welcome` | `/join` (query kept, so `/welcome?invite=X` → `/join?invite=X`) |
| `/invite` | `/people?tab=invite` |
| `/invite/:code` | `/join?invite=:code` (signed-in visitors continue to `/people?invite=`) |
| `/friends`, `/search` | `/people` |
| `/requests` | `/people?tab=requests` |
| `/notifications` | `/activity` |
| `/menu` | `/you` |
| `/messages/inbox` | `/messages` |
| `/groups`, `/groups/:id(/…)` | `/circles`, `/circles/:id` (`/groups/new` → `/circles/new`) |
| `/photos`, `/photos/new`, `/photos/album/:id`, `/photos/:id` | `/albums`, `/albums/new`, `/albums/:id`, `/albums` |
| `/settings`, `/settings/{account,privacy,security}`, `/settings/profile`, `/settings/*` | `/you/settings`, `/you/settings/{…}`, `/you`, `/you/settings` |
| `/legal` | `/legal/privacy` |
| `/circles/events/:path*`, `/circles/notes/:path*` | `/events/:path*`, `/notes/:path*` |
| `/games/*`, `/apps`, `/pages/*`, `/places/*`, `/pokes`, `/questions` | `/home` |
| `/:username`, `/:username/*` (v1 profiles) | `/u/:handle`, by the `app/[handle]` routes rather than a config redirect: redirects run before the filesystem, so a top-level catch-all there would shadow real routes. Static routes win over `[handle]`; reserved names and non-handles are a 404. |

The service worker (`public/sw.js`) also maps v1 paths in pushes queued by older servers.

## 3. Deleted

- **Routes**: all of `src/app/(classic)` (54 pages, its layout and its two stylesheets): profiles, apps, events, friends, games
  (Kithville), groups, help, invite, legal, login, menu, messages inbox, mod, notes, notifications, pages,
  photos, places, pokes, post, questions, recover, requests, search, settings, welcome.
- **Components**: `Shell`, `MobileChrome`, `ChatDock`, the v1 `Icon` and `Avatar`, `ReportDialog`, `legacy/`
  (LegacyDocument), and the v1 `feed/`, `games/`, `groups/`, `pages/`, `photos/`, `profile/`, `social/`
  directories; v1 files in `events/` and `messages/`; v1 `auth/` screens (Splash, PublicPage, LegalDoc,
  MfaForm, NewPassword, PhraseDisplay, SecuritySections, SettingsTabs, Dialog, AccountNotices); v1 push
  cards; `mod/ModConsole`; the phase-1 placeholder screens (`shell/screens.tsx`).
- **Library code**: `lib/games/kithville.ts`, `lib/pages.ts`, `lib/chat/dock.ts`, `lib/social/{lists,local,polls}.ts`,
  `lib/auth/hydrated.ts`, and v1-only functions inside the shared modules (pokes, Top News ranking,
  session search index, sharing, group docs and join requests, photo tag notices and reordering, birthday
  labels, v1 notification text/links, v1 email sign-up and email-session recovery helpers). Modules v2
  imports were kept.
- **API**: `/api/recovery/notify` (replaced by `/api/recovery/friends/start`, which notifies by itself).
- **CSS**: `kw2010.css`, `responsive.css`, `styles/{mobile,mobile-dark,auth,community,feed-media,messages,photos,social}.css`;
  `scripts/gen-dark.mjs` and the `gen:dark` npm script.
- **Compat**: the v1 theme exports in `lib/theme.ts` (`ThemePref`, `getThemePref`, …), the `data-theme` /
  `data-theme-pref` attributes, and the "v1 pages are English-only" rule in `public/theme.js` (every page
  now follows the chosen language and direction). The one-time migration of the v1 `kw.theme` setting
  stays, so returning v1 users keep their light/dark choice.

## 4. Database: dropped on 2026-10-23

Kithwall starts fresh (every account new, made with a passkey or passphrase), so nothing from v1 is exported or
carried over. `supabase/migrations/20261030000100_drop_classic.sql` (formerly the +30-days script
`supabase/launch/drop_classic_tables.sql`) dropped:

| Removed | v1 feature |
|---|---|
| `pokes`, `push_preferences.pokes`, notification type `poke` | Pokes |
| `pages`, `page_likes`, `posts.page_id`, notification / report object `page`, `page_like_count`, `classic_*` RPCs | Pages and their export |
| `poll_votes`, post kind `question`, notification type `question_vote` | Questions |
| post kinds `checkin` / `life_event`, notification type `checkin_tag` | Places, life events |
| `game_state`, `game_actions`, post kind `game`, notification type `game` | Kithville |
| `account_deletion_requests` and its RPCs, the account-deletions cron | "I've lost everything" (email reset only) |
| data-map category `legacy` | |

Kept, because Kithwall 2 uses them: `tag_notices` (album photo tags), `posts.wall_owner_id` (every profile post),
audiences of kind `list` (part of the audience authorization functions; the app no longer creates lists),
`key_changes`, `app_settings.public_audience_enabled`, and the reserved usernames for the old routes
(`lib/social/reserved.ts`). The client code for these features (classic export, Classic data card, poll/check-in/
life-event/game payloads, Page posts, poke pushes) was removed in the same change.

## 5. Verification (2026-10-21)

`next typegen` + `tsc --noEmit` clean; `eslint src` 0 errors (30 pre-existing advisory warnings);
`vitest run` 216 passed (9 skipped: the e2e suites without `E2E_BASE_URL`); `supabase test db` 13 files,
539 tests passed; `npm run build -w apps/web` succeeded. Against a dev server: every redirect above
answered 307 to the right place, every v2 route 200 (unknown legal docs and non-handles 404), the recovery
e2e suite passed, and a full browser walk-through of `/recover` (handle → recovery key → new passphrase →
Home) worked on an email-less account, which could then be found by @handle + passphrase sign-in.
Screenshots: `screens/cleanup-*.jpg` (help, legal in Arabic RTL with the Minimal dark style, recovery at 375px).
