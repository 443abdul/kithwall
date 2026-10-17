-- Social (feed, profiles, friends, notes, questions, places).
-- 1. Reserved usernames: /[username] is a catch-all route, so names that collide with app
--    routes (or static files) must never be registered.
-- 2. Per-user rate limit for the link-preview proxy (called by the route handler with the
--    user's JWT, so the limit is tracked in the database and holds across server instances).
-- 3. Index for per-kind listings (Notes, Questions, Places).

create function kw.is_reserved_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(name) = any (array[
    'about', 'account', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app', 'apps', 'auth',
    'blog', 'callback', 'careers', 'chat', 'developers', 'edit', 'event', 'events', 'explore',
    'favicon.ico', 'feed', 'friend', 'friends', 'game', 'games', 'group', 'groups', 'help', 'home',
    'icon.svg', 'invite', 'invites', 'kithville', 'kithwall', 'legal', 'list', 'lists', 'login', 'logout',
    'mail', 'manifest.webmanifest', 'message', 'messages', 'mod', 'moderation', 'moderator', 'new',
    'note', 'notes', 'notification', 'notifications', 'oauth', 'page', 'pages', 'photo', 'photos',
    'place', 'places', 'poke', 'pokes', 'post', 'posts', 'privacy', 'profile', 'question', 'questions',
    'recover', 'recovery', 'register', 'request', 'requests', 'reset', 'robots.txt', 'root', 'search',
    'security', 'settings', 'share', 'signin', 'signup', 'sitemap.xml', 'staff', 'static', 'status',
    'support', 'sw.js', 'system', 'terms', 'video', 'videos', 'welcome', 'www'
  ])
$$;

create function kw.profiles_reserved_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.username = old.username then return new; end if;
  if kw.is_reserved_username(new.username::text) then
    raise exception 'That username is reserved.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger profiles_reserved_guard before insert or update of username on public.profiles
  for each row execute function kw.profiles_reserved_guard();

-- Link previews: 60 per hour per user (plus a short in-memory burst limit in the route handler).
create function public.link_preview_quota() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not kw.is_active() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform kw.rate_limit('link_preview', 60, interval '1 hour');
end $$;

revoke execute on function public.link_preview_quota() from public, anon;
grant execute on function public.link_preview_quota() to authenticated, service_role;
revoke execute on function kw.is_reserved_username(text) from public, anon;
grant execute on function kw.is_reserved_username(text) to authenticated, service_role;
revoke execute on function kw.profiles_reserved_guard() from public, anon;

create index if not exists posts_author_kind on public.posts (author_id, kind, created_at desc);

-- 4. Authors and wall owners can always read their own posts by row columns. kw.can_read_post()
--    looks the post up by id, which a STABLE function cannot see during INSERT ... RETURNING, so
--    without this `insert().select()` (lib/content createPost) fails RLS for brand-new posts.
create policy "authors and wall owners read their posts" on public.posts
  for select to authenticated using (author_id = (select auth.uid()) or wall_owner_id = (select auth.uid()));
