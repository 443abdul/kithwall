-- Kithwall 2 stories (docs/v2/00-brief.md §4 "New: Stories (24 h) for connections or a chosen circle").
--
-- A story is end-to-end encrypted exactly like a post (docs/03-spec.md §3.8): the envelope is sealed on
-- the author's device to an audience key (the author's connections audience, or a circle's audience) and
-- signed with the author's identity key. The server stores ciphertext plus the minimum routing metadata:
-- author, audience + epoch, optional circle, and the expiry time.
--
--  * expires_at is set by the server (created_at + 24 h) and cannot be changed. Expired stories are
--    invisible to everyone but the author at once, and a pg_cron job deletes the rows every 10 minutes
--    (the ciphertext is gone from the database within minutes of expiry).
--  * Encrypted media (photos) live in the private `media` bucket and are registered in media_objects with
--    story_id. Readers can fetch them only while the story is live (kw.can_read_media). Storage objects are
--    removed by the web cron (/api/cron/stories) through the service-role RPC expired_story_media(); the
--    author's device also deletes them when a story is deleted by hand.
--  * story_views records who opened a story. Only the story's author (and the viewer for their own row)
--    can read it: there are no public view counts.

create table public.stories (
  id uuid primary key,                       -- client-generated (bound into the envelope header)
  author_id uuid not null references public.profiles (id) on delete cascade,
  audience_id uuid not null references public.audiences (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  group_id uuid references public.groups (id) on delete cascade,   -- the circle, when shared to one
  envelope jsonb not null check (octet_length(envelope::text) < 16384),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index stories_audience on public.stories (audience_id, expires_at desc);
create index stories_author on public.stories (author_id, created_at desc);
create index stories_expires on public.stories (expires_at);
alter table public.stories enable row level security;

-- May u read story s right now? (live, a member of its audience, not blocked by/blocking the author)
create function kw.can_read_story(s uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select author_id, audience_id, expires_at into r from public.stories where id = s;
  if not found then return false; end if;
  if r.author_id = u then return true; end if;
  if r.expires_at <= now() or kw.is_blocked(u, r.author_id) then return false; end if;
  return kw.is_member(r.audience_id, u);
end $$;

-- May the signed-in user create this story? Own connections audience, or a circle they belong to.
create function kw.can_story(s public.stories) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare aud record;
begin
  if s.author_id is distinct from auth.uid() or not kw.is_active() then return false; end if;
  select owner_id, kind into aud from public.audiences where id = s.audience_id;
  if not found or not kw.is_member(s.audience_id) then return false; end if;
  if s.group_id is null then
    return aud.owner_id = auth.uid() and aud.kind = 'friends';
  end if;
  return aud.kind = 'group'
     and exists (select 1 from public.groups g where g.id = s.group_id and g.audience_id = s.audience_id);
end $$;

-- Row-column checks first (an INSERT ... RETURNING cannot see the new row through a lookup by id).
create policy "authors read their stories" on public.stories
  for select to authenticated using (author_id = (select auth.uid()));
create policy "audience reads live stories" on public.stories
  for select to authenticated using (
    expires_at > now() and not kw.is_blocked((select auth.uid()), author_id) and kw.is_member(audience_id)
  );
create policy "share a story" on public.stories
  for insert to authenticated with check (kw.can_story(stories));
create policy "author or staff deletes story" on public.stories
  for delete to authenticated using (author_id = (select auth.uid()) or kw.is_staff());
-- No UPDATE policy: a story is immutable (delete and re-share instead).

create function kw.stories_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('story', 100, interval '1 day');
  new.created_at := now();
  new.expires_at := now() + interval '24 hours';
  return new;
end $$;
create trigger stories_guard before insert on public.stories
  for each row execute function kw.stories_guard();

-- Views: private to the author ------------------------------------------------------------------
create table public.story_views (
  story_id uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references public.profiles (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);
create index story_views_viewer on public.story_views (viewer_id);
alter table public.story_views enable row level security;

create function kw.story_author(s uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select author_id from public.stories where id = s
$$;

create policy "author sees who viewed; viewers see their own rows" on public.story_views
  for select to authenticated using (
    viewer_id = (select auth.uid()) or kw.story_author(story_id) = (select auth.uid())
  );
create policy "record your own view of a story you can read" on public.story_views
  for insert to authenticated with check (
    viewer_id = (select auth.uid()) and kw.can_read_story(story_id)
    and kw.story_author(story_id) <> (select auth.uid())
  );
-- No UPDATE/DELETE policies: a view is recorded once and goes away with the story.

create function kw.story_views_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.viewed_at := now();
  return new;
end $$;
create trigger story_views_guard before insert on public.story_views
  for each row execute function kw.story_views_guard();

-- Media: story photos ------------------------------------------------------------------------------
-- No foreign key on purpose: when the story row is deleted the media row stays (unreadable to anyone but
-- the owner) until the web cron has removed the storage object, so no ciphertext is ever orphaned.
alter table public.media_objects add column story_id uuid;
create index media_objects_story on public.media_objects (story_id) where story_id is not null;
alter table public.media_objects
  add constraint media_objects_one_link check (num_nonnulls(post_id, photo_id, message_id, story_id) <= 1);

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
                   where x.id = m.message_id and kw.is_member(c.audience_id, u));
  end if;
  if m.story_id is not null then return kw.can_read_story(m.story_id, u); end if;
  if m.profile_avatar then return kw.is_friend(m.owner_id, u); end if;
  return false;
end $$;

-- Expiry -------------------------------------------------------------------------------------------
-- Database side: delete expired story rows (views cascade). Runs every 10 minutes.
create function kw.story_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.stories where expires_at <= now();
end $$;
select cron.schedule('kithwall-story-maintenance', '*/10 * * * *', $$select kw.story_maintenance()$$);

-- Web cron side (service role only): storage paths of story media whose story is gone or expired.
-- The caller removes the storage objects and then the media_objects rows (forget_story_media).
create function public.expired_story_media(max_rows int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select m.path from public.media_objects m
   where m.story_id is not null
     and not exists (select 1 from public.stories s where s.id = m.story_id and s.expires_at > now())
   order by m.created_at
   limit least(greatest(max_rows, 1), 1000)
$$;

create function public.forget_story_media(paths text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.media_objects m
   where m.path = any (paths) and m.story_id is not null
     and not exists (select 1 from public.stories s where s.id = m.story_id and s.expires_at > now());
  get diagnostics n = row_count;
  return n;
end $$;

-- Every user-data table requires MFA when the account has enrolled it (20261018000100_auth_safety).
select kw.require_mfa('public.stories');
select kw.require_mfa('public.story_views');

-- Execute rights ---------------------------------------------------------------------------------
revoke execute on function kw.story_maintenance() from public, anon, authenticated;
revoke execute on function public.expired_story_media(int), public.forget_story_media(text[]) from public, anon, authenticated;
grant execute on function public.expired_story_media(int), public.forget_story_media(text[]) to service_role;
revoke execute on function kw.can_read_story(uuid, uuid), kw.can_story(public.stories), kw.story_author(uuid),
  kw.stories_guard(), kw.story_views_guard() from public, anon;
grant execute on function kw.can_read_story(uuid, uuid), kw.can_story(public.stories), kw.story_author(uuid)
  to authenticated, service_role;

-- Same invariant as 20261019000001_integration.sql: every public table has row level security.
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'tables without row level security: %', missing;
  end if;
end $$;
