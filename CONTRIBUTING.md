# Contributing to Kithwall

Thank you for helping. Kithwall is a small, privacy-first project, so a few rules here are stricter than
usual: they protect people who rely on it. By contributing you agree that your contribution is licensed
under the [AGPL-3.0](LICENSE) (`AGPL-3.0-only`) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Security problems are never reported in public issues.** See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node 22+ (CI uses 24), npm, Docker, the Supabase CLI.

```sh
npm install
supabase start                                  # local stack, ports 643xx (supabase/config.toml)
cp apps/web/.env.example apps/web/.env.local     # values printed by `supabase start`
npm run dev                                     # http://localhost:3000
```

- `apps/web` is **Next.js 16**, which has breaking changes from older versions. Read `apps/web/AGENTS.md`
  and the guides in `node_modules/next/dist/docs/` before changing routing, config or data fetching.
- Several dev servers can share one checkout: `NEXT_DIST_DIR=.next-mine npx next dev -p 3001`
  (PowerShell: `$env:NEXT_DIST_DIR='.next-mine'; npx next dev -p 3001`).
- Don't run `supabase db reset` against a database other people use. New migrations go in
  `supabase/migrations/<timestamp>_<name>.sql`; apply them with `supabase migration up --local`.
- The design documents in [`docs/v2`](docs/v2) explain each area. Read the relevant one first.

## Tests to run before you open a pull request

```sh
cd apps/web
npx next typegen && npx tsc --noEmit -p .    # types
npx eslint src                               # 0 errors
npx vitest run                               # unit tests (i18n catalogues, parsers, data map labels, …)
npm run build -w apps/web                    # from the repo root: production build
cd ../.. && npx vitest run --root packages/crypto
supabase test db                             # RLS and data-map tests (pgTAP)
```

For UI changes, check the screen at **375 px and 1280 px**, in at least one dark style, and in a
right-to-left language (Arabic, Persian or Urdu). Attach screenshots to the pull request.

## Rules that are not negotiable

1. **No plaintext user content reaches the server.** Content is sealed on the device through
   `packages/crypto` and the helpers in `apps/web/src/lib`. Never re-implement cryptography.
2. **No third-party anything at runtime**: no CDN scripts, fonts, images, iframes or analytics. The CSP is
   nonce-based and strict; `dangerouslySetInnerHTML` and `eval` are not allowed.
3. **Every new database table or column must be classified in the data map.** Add rows to
   `kw.data_map_tables` and `kw.data_map_columns` in the same migration, with `class` one of `id`, `time`,
   `plaintext`, `ciphertext` or `hashed` (envelopes and sealed columns are always `ciphertext`). The pgTAP
   test `supabase/tests/transparency.test.sql` fails on any unclassified or stale column. If people will care
   about the table, also add a plain-language label in `apps/web/src/lib/transparency/datamap.ts`. Also
   update the privacy policy if the new data is something people should know about.
4. **Every table has row-level security** with pgTAP tests for who can and cannot read and write it.
5. **Accessibility**: WCAG 2.2 AA. Real buttons and links, labels on every control, focus management in
   dialogs, enough contrast in every style (`node apps/web/scripts/check-contrast.mjs`).
6. **Right-to-left safe CSS**: use logical properties (`margin-inline-start`, `inset-inline-end`, …), never
   `left`/`right` for layout.
7. Components use only the semantic design tokens in `apps/web/src/styles/v2/tokens.css`, never raw colours.

## Translations

Kithwall ships in 12 languages: English, Urdu, Arabic, Persian, Hindi, Bengali, Chinese (Simplified),
Russian, Spanish, French, Portuguese and Turkish. Catalogues live in `apps/web/src/i18n/messages/<locale>.json`;
`en.json` is the source.

- **Every new or changed English string must be added to all 12 catalogues in the same change.** A machine
  translation is fine as a first draft. `src/i18n/i18n.test.ts` fails on missing or extra keys, lost
  `{placeholders}` or plural branches.
- Keep `{placeholders}`, ICU plural shapes (`{count, plural, one {…} other {…}}`) and Markdown such as
  `**bold**` and `[links](/path)` exactly as in English.
- **Native-speaker review is the most valuable help we can get.** Machine-drafted catalogues carry a
  `_meta.review` note. To review a language, open a pull request that corrects strings in that catalogue,
  and say in the description which sections you reviewed. Prefer natural, plain wording over literal
  translation, and keep the tone calm and friendly. When a whole catalogue has been reviewed, update its
  `_meta` note.
- Don't translate the product name "Kithwall" or `@handles`.
- To propose a new language, open an issue first: it needs a reviewer, fonts that cover the script and
  (for right-to-left scripts) a layout check.

## Commit and pull request style

- One logical change per commit. The subject line is imperative and under 72 characters
  (`Add safety-number QR to verify screen`), optionally prefixed with an area (`calls: …`). Explain the why in
  the body.
- Keep pull requests focused. Describe what changed, how you tested it, and include screenshots for UI.
- Don't commit secrets, `.env.local`, build folders (`.next*`) or generated files that aren't already tracked.
- CI (typecheck, lint, unit tests, build, dependency audit, pgTAP) must be green before review.

## Licence of contributions

Kithwall is licensed under the GNU Affero General Public License, version 3 only. Contributions are
accepted under the same licence (inbound = outbound). Only contribute code you wrote or have the right to
license this way, and keep third-party code's licence notices intact.
