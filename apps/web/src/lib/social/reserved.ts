// Usernames that collide with top-level routes or static files. `/[username]` is a catch-all
// segment, so these must never resolve to a profile. Mirrors kw.is_reserved_username() in
// supabase/migrations/20261102000700_reserve_v2_routes.sql (the database rejects them at sign-up).
export const RESERVED_USERNAMES: readonly string[] = [
  'about', 'account', 'activity', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app', 'apps',
  'auth', 'blog', 'callback', 'careers', 'chat', 'circles', 'design', 'developers', 'donate', 'edit',
  'event', 'events', 'explore', 'favicon.ico', 'feed', 'friend', 'friends', 'game', 'games', 'group',
  'groups', 'help', 'home', 'icon.svg', 'invite', 'invites', 'join', 'kithville', 'kithwall', 'legal',
  'list', 'lists', 'login', 'logout', 'mail', 'manifest.webmanifest', 'menu', 'message', 'messages', 'mod',
  'moderation', 'moderator', 'new', 'note', 'notes', 'notification', 'notifications', 'oauth', 'offline',
  'page', 'pages', 'people', 'photo', 'photos', 'place', 'places', 'poke', 'pokes', 'post', 'posts',
  'privacy', 'profile', 'question', 'questions', 'recover', 'recovery', 'register', 'request', 'requests',
  'reset', 'robots.txt', 'root', 'search', 'security', 'settings', 'setup', 'share', 'signin', 'signup',
  'sitemap.xml', 'staff', 'static', 'status', 'support', 'sw.js', 'system', 'terms', 'transparency', 'video',
  'videos', 'welcome', 'www', 'you',
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
