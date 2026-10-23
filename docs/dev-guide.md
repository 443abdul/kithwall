# Kithwall — Developer Guide

Read [03-spec.md](03-spec.md) first. This guide explains how the code is organised and the rules
every change must follow.

## Layout
```
apps/web/src/
  app/                    routes (App Router). Every page is a client component inside <AppPage>.
  components/
    Shell.tsx             header (jewels, search, account menu), LeftNav, Footer, AppPage, Title, RightBox
    Avatar.tsx Icon.tsx   avatars (decrypted profile pictures) and 16px 2010 icons (JSX, no innerHTML)
    auth/ feed/ profile/ photos/ messages/ groups/ events/ pages/ games/ mod/   feature components
  lib/
    supabase.ts           sb() client, must() error helper
    keys/session.ts       session, unlock (passkey / passphrase / device), recovery phrase; useSession()
    keys/keyring.ts       audience keys: load, deliver to friends/members, rotate, create audiences
    keys/device.ts        "keep me logged in" (non-extractable WebCrypto key in IndexedDB)
    people.ts             profiles + decrypted profile info; usePerson(id)
    content.ts            posts & comments: createPost/readPost/addComment/readComment/setLike/fetchFeed/fetchWall
    photos.ts             albums & photos: createAlbum/addPhotos/readPhoto/tagFriend/setProfilePicture
    media.ts              encrypted uploads & useFileUrl(ref) for display
    messages.ts           conversations & messages
    friends.ts            requests, accept, unfriend (rotates key), block, poke, saveProfileInfo
    notifications.ts      list, mark read, decrypt preview, text/icon/href helpers
    hooks.ts              React Query hooks shared by the shell
    format.ts types.ts
  app/kw2010.css          the 2010 design system — class names match reference/theassbook-2010.html
  app/responsive.css      tablet/mobile layer
packages/crypto           all cryptography (do not re-implement anything from here)
supabase/migrations       schema + RLS;  supabase/tests  pgTAP RLS tests
```

## Rules (non-negotiable)
1. **Never send plaintext user content to Supabase or any server.** Create/read content only through
   `lib/content.ts`, `lib/photos.ts`, `lib/messages.ts`, `lib/friends.ts` (profile info), or new
   functions built the same way (`sealEnvelope` with a header that binds the row id, author and
   audience; `openEnvelope` to read; verify before display).
2. **Public** content is only possible when `app_settings.public_audience_enabled` is true
   (`useAppSetting('public_audience_enabled')`). Default is friends-only. Show a globe + "Public — not
   encrypted" label whenever something is public; show a padlock for encrypted audiences.
3. No `dangerouslySetInnerHTML`, no `eval`, no third-party scripts, fonts, images or iframes.
   Production CSP enforces Trusted Types. Inline `style={{}}` is fine.
4. User links: only `http:`/`https:`, rendered with `rel="noopener noreferrer nofollow"` and `target="_blank"`.
5. Items that can't be decrypted yet render the "waiting" state: *"Waiting for {name}'s device to
   share this with you."* Items that fail verification render *"This item couldn't be verified."*
6. Match the 2010 reference markup and classes. Open `reference/theassbook-2010.html` in a browser
   and copy its structure (look at the `v*` view functions for each screen).
7. Responsive: every page must work at 390 px wide. Use the existing classes (they adapt via
   responsive.css); put any new CSS in `src/styles/<area>.css` and import it from your components.
8. Accessibility: buttons are `<button>` or `role="button"` with keyboard support; images have alt;
   dialogs trap focus and close on Escape.
9. Keep TypeScript strict; `npx tsc --noEmit` in `apps/web` must pass.

## Data & live updates
React Query keys used by the realtime bridge (Providers.tsx): `['notifications']`, `['friends', …]`,
`['requests']`, `['pokes']`, `['conversations']`, `['messages', convId]`, `['comments', postOrPhotoId]`,
`['likes', …]`. Use these keys so live updates refresh your views. Any change to keys triggers a full
invalidation via the keyring subscription.

## Running locally
- Database: `supabase start` (already running; API on http://127.0.0.1:64321, mail viewer
  http://127.0.0.1:64324). **Do not run `supabase db reset`** — other people share this database.
  New migrations: create `supabase/migrations/<your assigned prefix>_<name>.sql`, apply with
  `supabase migration up --local`, add pgTAP tests in `supabase/tests/`, run `supabase test db`.
- Web: from `apps/web`, run your own dev server with your own build folder, e.g.
  `NEXT_DIST_DIR=.next-b npx next dev -p 3002` (PowerShell: `$env:NEXT_DIST_DIR='.next-b'; npx next dev -p 3002`).
- Test accounts: create them through `/join` at your port, with a passkey (open the app at `http://localhost:<port>`,
  not 127.0.0.1: WebAuthn refuses IP addresses) or the passphrase fallback (@handle + a passphrase of at least 10
  characters with a decent strength score). There is no email sign-up.
