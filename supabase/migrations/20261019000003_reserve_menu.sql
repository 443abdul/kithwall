-- Reserve "menu" (new mobile Menu route at /menu).
create or replace function kw.is_reserved_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(name) = any (array[
    'about', 'account', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app', 'apps', 'auth',
    'blog', 'callback', 'careers', 'chat', 'developers', 'edit', 'event', 'events', 'explore',
    'favicon.ico', 'feed', 'friend', 'friends', 'game', 'games', 'group', 'groups', 'help', 'home',
    'icon.svg', 'invite', 'invites', 'kithville', 'kithwall', 'legal', 'list', 'lists', 'login', 'logout',
    'mail', 'menu', 'manifest.webmanifest', 'message', 'messages', 'mod', 'moderation', 'moderator', 'new',
    'note', 'notes', 'notification', 'notifications', 'oauth', 'page', 'pages', 'photo', 'photos',
    'place', 'places', 'poke', 'pokes', 'post', 'posts', 'privacy', 'profile', 'question', 'questions',
    'recover', 'recovery', 'register', 'request', 'requests', 'reset', 'robots.txt', 'root', 'search',
    'security', 'settings', 'share', 'signin', 'signup', 'sitemap.xml', 'staff', 'static', 'status',
    'support', 'sw.js', 'system', 'terms', 'video', 'videos', 'welcome', 'www'
  ])
$$;
