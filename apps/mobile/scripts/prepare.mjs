// Writes the only web content bundled in the app: the offline / error page (www/offline.html, also
// www/index.html because `cap sync` requires one). It has no access to native plugins and loads
// nothing remote; "Try again" goes back to the configured origin.
// Usage: node scripts/prepare.mjs   (KITHWALL_ENV=staging for the staging origin)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINS = { production: 'https://www.kithwall.com', staging: 'https://staging.kithwall.com' };
const env = process.env.KITHWALL_ENV === 'staging' ? 'staging' : 'production';
const origin = ORIGINS[env];
const www = join(dirname(fileURLToPath(import.meta.url)), '..', 'www');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-__HASH__'; img-src data:">
<meta name="color-scheme" content="light dark">
<title>Kithwall</title>
<style>
  :root { --bg: #fbf6f0; --fg: #2b211b; --muted: #6b5a4e; --accent: #b4532a; --on-accent: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1613; --fg: #f3ebe4; --muted: #c2b3a7; --accent: #ec8d61; --on-accent: #1b1613; } }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px 16px; box-sizing: border-box; text-align: center; gap: 12px; }
  h1 { font-size: 22px; margin: 0; }
  p { margin: 0; color: var(--muted); max-width: 32em; }
  a.button { margin-top: 12px; padding: 12px 24px; border-radius: 999px; background: var(--accent); color: var(--on-accent);
    text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Kithwall can’t connect</h1>
  <p>Check that you’re online, then try again. Nothing was lost: your messages stay end-to-end encrypted on the server until you’re back.</p>
  <p>If this keeps happening, update “Android System WebView” (Android) or iOS, then reopen Kithwall.</p>
  <a class="button" id="retry" href="${origin}/">Try again</a>
</main>
<script>__SCRIPT__</script>
</body>
</html>
`;
// The only script: retry automatically when the device comes back online.
const script = `addEventListener('online',function(){location.replace(${JSON.stringify(origin + '/')})});`;
const { createHash } = await import('node:crypto');
const hash = createHash('sha256').update(script).digest('base64');
const html = page.replace('__SCRIPT__', script).replace('__HASH__', hash);

mkdirSync(www, { recursive: true });
writeFileSync(join(www, 'offline.html'), html);
writeFileSync(join(www, 'index.html'), html);
console.log(`www/ prepared for ${env} (${origin})`);
