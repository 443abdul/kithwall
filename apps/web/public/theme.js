// Applies the saved appearance (System / Light / Dark) before first paint, so there's no white flash.
// Per-device preference in localStorage; it isn't sensitive and never leaves the device.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('kw.theme') || 'system'; } catch (e) { /* storage blocked */ }
  if (pref !== 'light' && pref !== 'dark') pref = 'system';
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
})();
