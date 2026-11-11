-- Reels: short vertical videos (docs/v2/12-reels.md).
--
-- A reel is a post of kind 'reel': one video of at most a minute, re-encoded on the author's device, with a
-- cover and a caption. It uses everything posts already have and adds no table and no column:
--
--  * audience      Public (signed, readable by anyone) or any encrypted audience (connections, followers, a
--                  circle, close friends, only me), exactly like other posts. The video and its cover are the
--                  same encrypted objects in the private media bucket as any post video.
--  * safety        reports, the automatic hiding of a reported public post, moderators, blocks, restrictions
--                  and the "who can comment" setting all apply unchanged, because a reel is a post.
--  * limits        a per-account daily limit (kw.rate_limit 'reel') and a size cap on the files of a reel,
--                  checked against the size the storage service recorded, not the size the client claimed.
--  * feeds         public reels come from explore_posts(p_kinds => '{reel}'): generic pages, the same for
--                  everyone. Reels of the people I follow, my connections and my circles come from reel_feed().
--
-- What is deliberately NOT here: any table, column or function that records what somebody watched. The feed is
-- ordered on the device from a profile that never leaves it; the server gets no views, impressions or watch
-- time (supabase/tests/reels.test.sql asserts that nothing of the kind exists).

-- ---------------------------------------------------------------------------------------
-- 1. Operator settings
-- ---------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('reels_enabled', 'true'::jsonb),
  ('reel_daily_limit', '10'::jsonb),
  ('reel_max_mb', '16'::jsonb)
on conflict (key) do nothing;

create function kw.app_settings_reels_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lo int; hi int;
begin
  if new.key = 'reels_enabled' and jsonb_typeof(new.value) <> 'boolean' then
    raise exception '% must be true or false', new.key using errcode = '22023';
  end if;
  if new.key in ('reel_daily_limit', 'reel_max_mb') then
    -- The media bucket stores at most 30 MiB per object, so a reel file can never be allowed more than that.
    if new.key = 'reel_daily_limit' then lo := 1; hi := 200; else lo := 1; hi := 30; end if;
    if not (jsonb_typeof(new.value) = 'number'
            and (new.value #>> '{}')::numeric = trunc((new.value #>> '{}')::numeric)
            and (new.value #>> '{}')::numeric between lo and hi) then
      raise exception '% must be a whole number between % and %', new.key, lo, hi using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger app_settings_reels_guard before insert or update on public.app_settings
  for each row execute function kw.app_settings_reels_guard();

create function kw.reels_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value = 'true'::jsonb from public.app_settings s where s.key = 'reels_enabled'), false)
$$;

-- How much a reel's files (video and cover) may take together, in bytes of stored (encrypted) data.
create function kw.reel_max_bytes() returns bigint
language sql stable security definer set search_path = '' as $$
  select kw.setting_int('reel_max_mb', 16)::bigint * 1024 * 1024
$$;

-- ---------------------------------------------------------------------------------------
-- 2. The post kind
-- ---------------------------------------------------------------------------------------
alter table public.posts drop constraint posts_kind_check;
alter table public.posts add constraint posts_kind_check
  check (kind in ('status', 'photo', 'link', 'video', 'note', 'share', 'reel'));
create index posts_reels_recent on public.posts (created_at desc) where kind = 'reel';

-- A reel goes on its author's own profile or into a circle (never on someone else's profile, into an event
-- or as a repost), only while the operator has reels on, and at most reel_daily_limit a day per account.
-- Who may read it is decided by the same rules as for every post (kw.can_post / kw.can_read_post).
create function kw.posts_reel_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'reel' then return new; end if;
  if not kw.reels_on() then
    raise exception 'reels are turned off' using errcode = '42501';
  end if;
  if new.event_id is not null or new.shared_post_id is not null
     or (new.wall_owner_id is not null and new.wall_owner_id <> new.author_id) then
    raise exception 'a reel goes on your own profile or into a circle' using errcode = '22023';
  end if;
  perform kw.rate_limit('reel', kw.setting_int('reel_daily_limit', 10), interval '1 day');
  return new;
end $$;
create trigger posts_reel_guard before insert on public.posts
  for each row execute function kw.posts_reel_guard();

-- ---------------------------------------------------------------------------------------
-- 3. The size cap on a reel's files
-- ---------------------------------------------------------------------------------------
-- Files are uploaded first and linked to their post afterwards (media_objects.post_id). When the post is a
-- reel, the link is only accepted for a file that is already stored, and only while the reel's files together
-- (its video and its cover) stay within the cap. Sizes are the ones the storage service recorded
-- (media_objects.bytes is what the client said; the larger of the two counts). A reel takes at most three
-- files.
create function kw.media_reel_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cap bigint; stored bigint; others bigint; n int;
begin
  if new.post_id is null then return new; end if;
  if not exists (select 1 from public.posts p where p.id = new.post_id and p.kind = 'reel') then return new; end if;
  cap := kw.reel_max_bytes();
  select (o.metadata ->> 'size')::bigint into stored
    from storage.objects o where o.bucket_id = 'media' and o.name = new.path;
  if stored is null then
    raise exception 'upload the file before adding it to a reel' using errcode = '22023';
  end if;
  select count(*), coalesce(sum(greatest(coalesce((o.metadata ->> 'size')::bigint, 0), m.bytes)), 0) into n, others
    from public.media_objects m
    left join storage.objects o on o.bucket_id = 'media' and o.name = m.path
   where m.post_id = new.post_id and m.path <> new.path;
  if greatest(stored, new.bytes) + others > cap then
    raise exception 'the files of a reel can be at most % MB together', cap / 1048576 using errcode = 'P0413';
  end if;
  if n >= 3 then
    raise exception 'a reel has one video and one cover' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger media_reel_guard before insert or update on public.media_objects
  for each row execute function kw.media_reel_guard();

-- Once a file belongs to a reel it cannot be swapped for another one under the same name (delete it and
-- upload a larger one): nothing new is stored at a path a reel uses.
create function kw.reel_file_locked(object_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.media_objects m join public.posts p on p.id = m.post_id
                  where m.path = object_path and p.kind = 'reel')
$$;
create policy "a reel's files cannot be replaced" on storage.objects as restrictive
  for insert to authenticated with check (bucket_id <> 'media' or not kw.reel_file_locked(name));

-- ---------------------------------------------------------------------------------------
-- 4. Reels of the people I follow, my connections and my circles
-- ---------------------------------------------------------------------------------------
-- Newest first, in plain pages; never my own. Row-level security still decides every row (blocks, hidden
-- public posts, expiry, audience membership). Nothing about the caller is recorded, and the page that comes
-- back does not depend on anything the caller watched.
create function public.reel_feed(p_before timestamptz default null, p_limit int default 24)
returns setof public.posts
language sql stable set search_path = '' as $$
  select p.* from public.posts p
  where p.kind = 'reel'
    and (p_before is null or p.created_at < p_before)
    and (p.publish_at is null or p.publish_at <= now())
    and p.author_id <> auth.uid()
    and (
      p.author_id in (select case when f.user_a = auth.uid() then f.user_b else f.user_a end
                        from public.friendships f
                       where f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b))
      or (p.wall_owner_id = p.author_id
          and p.author_id in (select fo.followee_id from public.follows fo where fo.follower_id = auth.uid()))
      or p.group_id in (select g.id from public.groups g join public.audience_members m on m.audience_id = g.audience_id
                         where m.member_id = auth.uid() and m.status = 'active')
    )
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 24), 1), 50)
$$;

-- ---------------------------------------------------------------------------------------
-- 5. /reels is a route: reserve the handle (keep in sync with apps/web/src/lib/social/reserved.ts)
-- ---------------------------------------------------------------------------------------
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
    'posts', 'privacy', 'profile', 'question', 'questions', 'recover', 'recovery', 'reel', 'reels', 'register',
    'request', 'requests', 'reset', 'robots.txt', 'root', 'search', 'security', 'settings', 'setup', 'share',
    'signin', 'signup', 'sitemap.xml', 'staff', 'static', 'status', 'support', 'sw.js', 'system', 'terms',
    'transparency', 'video', 'videos', 'welcome', 'www', 'you'
  ])
$$;

-- ---------------------------------------------------------------------------------------
-- 6. Data map (transparency): no new table or column; two notes say what a reel is
-- ---------------------------------------------------------------------------------------
update kw.data_map_columns set note = 'status, photo, video, note, reel…'
 where table_name = 'public.posts' and column_name = 'kind';
update kw.data_map_tables
   set note = 'Counts of actions (not their content) used for spam limits, for example how many reels you posted today. Never what you watched.'
 where table_name = 'kw.rate_events';

-- ---------------------------------------------------------------------------------------
-- Execute rights (new functions default to PUBLIC; match the rest of the schema)
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.app_settings_reels_guard(), kw.posts_reel_guard(), kw.media_reel_guard()
  from public, anon, authenticated;
revoke execute on function kw.reels_on(), kw.reel_max_bytes(), kw.reel_file_locked(text) from public, anon;
grant execute on function kw.reels_on(), kw.reel_max_bytes(), kw.reel_file_locked(text) to authenticated, service_role;
revoke execute on function public.reel_feed(timestamptz, int) from public, anon;
grant execute on function public.reel_feed(timestamptz, int) to authenticated, service_role;
