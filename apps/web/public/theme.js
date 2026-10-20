// Applies saved appearance + language before first paint (no flash, no layout flip). Runs as an external
// same-origin script with the CSP nonce (see app/layout.tsx). Per-device prefs in localStorage; they
// aren't sensitive and never leave the device. Mirrors lib/theme.ts and i18n/locales.ts (kept in sync
// by i18n.test.ts / theme.test.ts).
(function () {
  var root = document.documentElement;
  var store = null;
  try { store = window.localStorage; } catch (e) { /* storage blocked */ }
  function get(k) { try { return store ? store.getItem(k) : null; } catch (e) { return null; } }
  function put(k, v) { try { if (store) { if (v === null) store.removeItem(k); else store.setItem(k, v); } } catch (e) { /* ignore */ } }

  // ---- appearance: style (warm | minimal | bold) × mode (system | light | dark)
  var CHROME = {
    warm: { light: '#fbf6f0', dark: '#1b1613' },
    minimal: { light: '#ffffff', dark: '#0a0a0a' },
    bold: { light: '#f8f4ff', dark: '#110925' }
  };
  var style = get('kw.style');
  if (!CHROME[style]) style = 'warm';
  var mode = get('kw.mode');
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
    var legacy = get('kw.theme'); // v1 appearance setting
    mode = legacy === 'light' || legacy === 'dark' ? legacy : 'system';
    if (legacy === 'light' || legacy === 'dark') put('kw.mode', legacy);
    if (legacy !== null) put('kw.theme', null);
  }
  var dark = mode === 'dark' || (mode === 'system' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
  var resolved = dark ? 'dark' : 'light';
  root.setAttribute('data-style', style);
  root.setAttribute('data-mode', resolved);
  root.setAttribute('data-mode-pref', mode);

  function themeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', CHROME[style][resolved]);
  }
  themeColor();
  document.addEventListener('DOMContentLoaded', themeColor);

  // ---- language: saved choice, else the first supported device language
  var LOCALES = ['en', 'ur', 'ar', 'fa', 'hi', 'bn', 'zh', 'ru', 'es', 'fr', 'pt', 'tr'];
  var RTL = { ur: 1, ar: 1, fa: 1 };
  var locale = get('kw.locale');
  if (LOCALES.indexOf(locale) < 0) {
    locale = 'en';
    var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i++) {
      var base = String(langs[i] || '').toLowerCase().split(/[-_]/)[0];
      if (LOCALES.indexOf(base) >= 0) { locale = base; break; }
    }
  }
  root.setAttribute('lang', locale === 'zh' ? 'zh-Hans' : locale);
  root.setAttribute('dir', RTL[locale] ? 'rtl' : 'ltr');
  // Hide v2 text until a non-English catalogue has loaded (styles/v2/base.css; cleared by i18n/index.ts).
  if (locale !== 'en') root.setAttribute('data-i18n-pending', '');
})();
