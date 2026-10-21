-- Security review P1/L5, L4, I1, I3 (docs/v2/06-security-review.md) and the reserved-handle list.
--
-- P1/L5: "Blocked people can't see anything you share or message you" — but a blocked person kept
--        reading the existing 1:1 history (message reads checked membership only). Now, while A blocks B,
--        B can't read their 1:1 chat with A (messages, reactions, attachments). A still can (evidence for
--        a report). Group chats are a shared key, so a blocked person still sees what is sent to a group
--        you are both in; the privacy copy says so.
-- L4:    uploads into the media bucket count against a daily limit and a per-account total, and objects
--        that never got their media_objects row are removed by the ephemeral cron after a day.
-- I1:    anon / authenticated lose TRUNCATE, TRIGGER and REFERENCES on public tables (defence in depth).
-- I3:    kw.rate_limit serialises per user and action, so concurrent bursts can't exceed a limit.
-- Handles: 'donate' is a top-level route (/donate) and is reserved like the others
--          (apps/web/src/lib/social/reserved.ts).

-- ---------------------------------------------------------------------------------------
-- P1 / L5
-- ---------------------------------------------------------------------------------------
-- True when conversation `conv` is a 1:1 chat and the OTHER person has blocked `u`.
create function kw.dm_hidden_from(conv uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversations c
      join public.blocks b on b.blocked = u and b.blocker <> u
     where c.id = conv and c.dm_key is not null
       and u::text = any (string_to_array(c.dm_key, ':'))
       and b.blocker::text = any (string_to_array(c.dm_key, ':')))
$$;
revoke execute on function kw.dm_hidden_from(uuid, uuid) from public, anon;
grant execute on function kw.dm_hidden_from(uuid, uuid) to authenticated, service_role;

create policy "blocked people lose the 1:1 history" on public.messages as restrictive
  for select to authenticated using (not kw.dm_hidden_from(conversation_id));
create policy "blocked people lose the 1:1 reactions" on public.message_reactions as restrictive
  for select to authenticated using (not kw.dm_hidden_from(conversation_id));

create or replace function kw.can_read_media(object_path text, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare m record;
begin
  select * into m from public.media_objects where path = object_path;
  if not found then return false; end if;
  if m.owner_id = u then return true; end if;
  if kw.is_blocked(u, m.owner_id) then return false; end if;
  if m.post_id is not null then return kw.can_read_post(m.post_id, u); end if;
  if m.photo_id is not null then return kw.can_read_photo(m.photo_id, u); end if;
  if m.message_id is not null then
    return exists (select 1 from public.messages x join public.conversations c on c.id = x.conversation_id
                   where x.id = m.message_id and x.unsent_at is null
                     and (x.expires_at is null or x.expires_at > now())
                     and kw.is_member(c.audience_id, u)
                     and not kw.dm_hidden_from(c.id, u));
  end if;
  if m.story_id is not null then return kw.can_read_story(m.story_id, u); end if;
  if m.profile_avatar then return kw.is_friend(m.owner_id, u); end if;
  return false;
end $$;

-- ---------------------------------------------------------------------------------------
-- L4: storage quota and orphans
-- ---------------------------------------------------------------------------------------
-- Called from the storage INSERT policy: counts the upload (3000 objects a day; a video is several) and
-- refuses once the account stores 10 GiB of encrypted files.
create function kw.media_quota_ok() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return true; end if;
  perform kw.rate_limit('media_upload', 3000, interval '1 day');
  return coalesce((select sum(m.bytes) from public.media_objects m where m.owner_id = auth.uid()), 0)
         < 10::bigint * 1024 * 1024 * 1024;
end $$;
revoke execute on function kw.media_quota_ok() from public, anon;
grant execute on function kw.media_quota_ok() to authenticated, service_role;

create policy "media upload quota" on storage.objects as restrictive
  for insert to authenticated with check (bucket_id <> 'media' or kw.media_quota_ok());

-- Server-only: media objects older than a day that never got a media_objects row (nobody else can
-- read them, kw.can_read_media; this frees the space). The ephemeral cron removes them via the
-- Storage API so the bytes go too.
create function public.orphaned_media(max_rows int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
   where o.bucket_id = 'media' and o.created_at < now() - interval '1 day'
     and not exists (select 1 from public.media_objects m where m.path = o.name)
   order by o.created_at
   limit least(greatest(max_rows, 1), 1000)
$$;
revoke execute on function public.orphaned_media(int) from public, anon, authenticated;
grant execute on function public.orphaned_media(int) to service_role;

-- ---------------------------------------------------------------------------------------
-- I1, I3
-- ---------------------------------------------------------------------------------------
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

create or replace function kw.rate_limit(action text, max_count int, per interval) returns void
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then return; end if; -- service role / migrations
  perform pg_advisory_xact_lock(hashtextextended('kw.rate:' || auth.uid()::text || ':' || rate_limit.action, 0));
  select count(*) into n from kw.rate_events r
   where r.user_id = auth.uid() and r.action = rate_limit.action and r.at > now() - per;
  if n >= max_count then
    raise exception 'rate limit exceeded for %', action using errcode = 'P0429';
  end if;
  insert into kw.rate_events (user_id, action) values (auth.uid(), action);
end $$;

-- ---------------------------------------------------------------------------------------
-- Reserved handles (keep in sync with apps/web/src/lib/social/reserved.ts)
-- ---------------------------------------------------------------------------------------
create or replace function kw.is_reserved_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(name) = any (array[
    'about', 'account', 'admin', 'ads', 'advertising', 'album', 'albums', 'api', 'app', 'apps', 'auth',
    'blog', 'callback', 'careers', 'chat', 'developers', 'donate', 'edit', 'event', 'events', 'explore',
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
