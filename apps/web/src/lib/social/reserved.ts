// Usernames that collide with top-level routes or static files. `/[username]` is a catch-all
// segment, so these must never resolve to a profile. Mirrors kw.is_reserved_username() in
// supabase/migrations/20261018000200_social.sql (the database rejects them at sign-up).
export const RESERVED_USERNAMES: readonly string[] = [
  'about', 'account', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app', 'apps', 'auth',
  'blog', 'callback', 'careers', 'chat', 'developers', 'edit', 'event', 'events', 'explore',
  'favicon.ico', 'feed', 'friend', 'friends', 'game', 'games', 'group', 'groups', 'help', 'home',
  'icon.svg', 'invite', 'invites', 'kithville', 'kithwall', 'legal', 'list', 'lists', 'login', 'logout',
  'mail', 'manifest.webmanifest', 'message', 'messages', 'mod', 'moderation', 'moderator', 'new',
  'note', 'notes', 'notification', 'notifications', 'oauth', 'page', 'pages', 'photo', 'photos',
  'place', 'places', 'poke', 'pokes', 'post', 'posts', 'privacy', 'profile', 'question', 'questions',
  'recover', 'recovery', 'register', 'request', 'requests', 'reset', 'robots.txt', 'root', 'search',
  'security', 'settings', 'share', 'signin', 'signup', 'sitemap.xml', 'staff', 'static', 'status',
  'support', 'sw.js', 'system', 'terms', 'video', 'videos', 'welcome', 'www',
];

const SET = new Set(RESERVED_USERNAMES);
const USERNAME_RE = /^[a-z0-9][a-z0-9.]{2,29}$/;

export function isReservedUsername(name: string): boolean {
  return SET.has(name.toLowerCase());
}

/** True when `name` could be a real profile URL (valid shape and not a reserved route name). */
export function isProfileUsername(name: string): boolean {
  const n = name.toLowerCase();
  return USERNAME_RE.test(n) && !SET.has(n);
}
