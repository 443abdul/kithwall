// Writes the only web content bundled in the app: the offline / error page (www/offline.html, also
// www/index.html because `cap sync` requires one). It has no access to native plugins and loads
// nothing remote; "Try again" goes back to the configured origin, and "Open Kit Drop" (only when the app says
// the origin's service worker keeps the offline shell) opens <origin>/offline, which works without a connection.
// Usage: node scripts/prepare.mjs   (KITHWALL_ENV=staging for the staging origin)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINS = { production: 'https://www.kithwall.com', staging: 'https://staging.kithwall.com', local: 'http://127.0.0.1:3073' };
const env = process.env.KITHWALL_ENV === 'staging' ? 'staging' : process.env.KITHWALL_ENV === 'local' ? 'local' : 'production';
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
  a.button.secondary { margin-top: 0; background: transparent; color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Kithwall can’t connect</h1>
  <p>Check that you’re online, then try again. Nothing was lost: your messages stay end-to-end encrypted on the server until you’re back.</p>
  <p>If this keeps happening, update “Android System WebView” (Android) or iOS, then reopen Kithwall.</p>
  <a class="button" id="retry" href="${origin}/">Try again</a>
  <p id="kd-note" hidden>Kit Drop works without a connection: posts you write wait there, encrypted, and you can pass posts on as a file.</p>
  <p id="kd-file" hidden>The Kit Drop file you opened is waiting there.</p>
  <a class="button secondary" id="kitdrop" hidden>Open Kit Drop</a>
</main>
<script>__SCRIPT__</script>
</body>
</html>
`;
// The only script: retry automatically when the device comes back online; and when the app says this origin's
// service worker keeps the offline shell (?shell=<origin>, KwWebViewClient; docs/v2/08-censorship.md §5),
// offer Kit Drop there (`file=1`: a Kit Drop file handed to the app is waiting).
const script = `addEventListener('online',function(){location.replace(${JSON.stringify(origin + '/')})});`
  + `(function(){var q=new URLSearchParams(location.search),o=q.get('shell');`
  + `if(!o||!(o===${JSON.stringify(origin)}||/^https:\\/\\/[a-z0-9.-]+(:\\d+)?$/i.test(o)))return;`
  + `var a=document.getElementById('kitdrop');a.href=o+'/offline';a.hidden=false;document.getElementById('kd-note').hidden=false;`
  + `if(q.get('file')==='1')document.getElementById('kd-file').hidden=false;})();`;
const { createHash } = await import('node:crypto');
const hash = createHash('sha256').update(script).digest('base64');
const html = page.replace('__SCRIPT__', script).replace('__HASH__', hash);

mkdirSync(www, { recursive: true });
writeFileSync(join(www, 'offline.html'), html);
writeFileSync(join(www, 'index.html'), html);
console.log(`www/ prepared for ${env} (${origin})`);
