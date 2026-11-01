-- Reserve the handles of the Kithwall 2 top-level routes (/activity, /circles, /design, /join, /offline,
-- /people, /setup, /transparency, /you): `/[handle]` is a catch-all, so a profile with one of these names
-- could never be opened. None were taken when this was written (checked 2026-11-02).
-- Keep in sync with apps/web/src/lib/social/reserved.ts.
create or replace function kw.is_reserved_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(name) = any (array[
    'about', 'account', 'activity', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app',
    'apps', 'auth', 'blog', 'callback', 'careers', 'chat', 'circles', 'design', 'developers', 'donate',
    'edit', 'event', 'events', 'explore', 'favicon.ico', 'feed', 'friend', 'friends', 'game', 'games',
    'group', 'groups', 'help', 'home', 'icon.svg', 'invite', 'invites', 'join', 'kithville', 'kithwall',
    'legal', 'list', 'lists', 'login', 'logout', 'mail', 'manifest.webmanifest', 'menu', 'message', 'messages',
    'mod', 'moderation', 'moderator', 'new', 'note', 'notes', 'notification', 'notifications', 'oauth', 'offline',
    'page', 'pages', 'people', 'photo', 'photos', 'place', 'places', 'poke', 'pokes', 'post',
    'posts', 'privacy', 'profile', 'question', 'questions', 'recover', 'recovery', 'register', 'request', 'requests',
    'reset', 'robots.txt', 'root', 'search', 'security', 'settings', 'setup', 'share', 'signin', 'signup',
    'sitemap.xml', 'staff', 'static', 'status', 'support', 'sw.js', 'system', 'terms', 'transparency', 'video',
    'videos', 'welcome', 'www', 'you'
  ])
$$;
