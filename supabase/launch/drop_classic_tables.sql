-- =============================================================================================
--  DO NOT APPLY BEFORE LAUNCH + 30 DAYS.  Kept outside supabase/migrations on purpose, so that
--  `supabase db push` never picks it up. See docs/v2/07-launch.md §9 for the procedure:
--    1. Launch + 30 days, after the "Download your Kithwall Classic data" notice has been up the whole time.
--    2. Copy this file to supabase/migrations/<timestamp>_drop_classic.sql in a PR that also removes the
--       Classic section from lib/export.ts + components/settings/DataSettings.tsx and the fixtures in
--       supabase/tests/{community,classic_export,transparency}.test.sql that use these tables (list in §9).
--    3. Rehearse (bash supabase/launch/rehearse.sh), take a backup, then `supabase db push`.
-- =============================================================================================
--
-- Retires the v1-only ("Kithwall Classic") data that Kithwall 2 neither shows nor writes
-- (docs/v2/02-cleanup.md §4):
--   tables     pokes, pages, page_likes, poll_votes, game_state, game_actions
--   rows       posts on Pages and Kithville posts (kind 'game', hidden in v2); their comments, likes,
--              notifications and media go with them (cascades + kw.post_gone; files via the media trash);
--              notifications of the v1-only types poke / game / question_vote / checkin_tag and about Pages
--   functions  page_like_count, classic_liked_pages, classic_page_posts and the four table guards
--   policies   "only page owners post on pages"; the post delete policy is recreated without its Page clause
--   checks     posts: no Page wall, no 'game' kind; notifications: v1-only types and the 'page' object removed
--   data map   the six tables leave kw.data_map_tables (their columns cascade)
-- Kept on purpose:
--   * tag_notices: Kithwall 2 albums still write photo tags there (lib/photos.ts).
--   * posts.page_id (always null after this; enforced by posts_no_page): the v2 client still names it in
--     PostRow and the envelope header; drop it together with that code later.
--   * push_preferences.pokes: still read by lib/push.ts; drop with the client.
--   * posts of kind 'question' / 'checkin' / 'life_event': their text still shows in v2 feeds (votes go).
--   * audiences of kind 'list' (friend lists): posts encrypted to them must stay readable.
--   * reports about Pages (target_kind 'page'): moderation records follow their own one-year retention.
-- No pg_cron job, type, storage bucket or Vercel cron belongs to these features.

begin;

-- Make sure we are where we think we are (v2 schema, classic tables still present).
do $$
begin
  if to_regclass('public.passkeys') is null or to_regclass('public.pokes') is null then
    raise exception 'unexpected schema: run this only on the Kithwall 2 database that still has the classic tables';
  end if;
end $$;

-- 1. Content that only existed for classic features ---------------------------------------------
delete from public.posts where page_id is not null;       -- Page walls (public posts)
delete from public.posts where kind = 'game';             -- Kithville stories (hidden in v2)
delete from public.notifications
 where type in ('poke', 'game', 'question_vote', 'checkin_tag') or object_kind = 'page';

-- 2. Posts: no more Pages or Kithville --------------------------------------------------------------
drop policy if exists "only page owners post on pages" on public.posts;
drop policy if exists "author, wall owner, group admin or staff deletes post" on public.posts;
create policy "author, wall owner, group admin or staff deletes post" on public.posts
  for delete to authenticated using (
    author_id = (select auth.uid()) or wall_owner_id = (select auth.uid()) or kw.is_staff()
    or (group_id is not null and exists (select 1 from public.groups g
                                          where g.id = posts.group_id and kw.is_audience_admin(g.audience_id))));

create or replace function kw.can_post(p public.posts) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare aud record;
begin
  if p.author_id <> auth.uid() or not kw.is_active() then return false; end if;
  if p.is_public then
    if not kw.public_enabled() then return false; end if;
  else
    select owner_id, kind into aud from public.audiences where id = p.audience_id;
    if not found or not kw.is_member(p.audience_id) then return false; end if;
  end if;

  if p.wall_owner_id is not null then
    if p.wall_owner_id = auth.uid() then
      return p.is_public or (aud.owner_id = auth.uid() and aud.kind in ('friends', 'list', 'self'));
    end if;
    return kw.is_friend(auth.uid(), p.wall_owner_id) and not kw.is_blocked(auth.uid(), p.wall_owner_id)
       and not p.is_public and aud.owner_id = p.wall_owner_id and aud.kind = 'friends';
  elsif p.group_id is not null then
    return exists (select 1 from public.groups g where g.id = p.group_id
                   and ((not p.is_public and g.audience_id = p.audience_id)
                     or (p.is_public and g.privacy = 'open')))
       and exists (select 1 from public.groups g where g.id = p.group_id and kw.is_member(g.audience_id));
  elsif p.event_id is not null then
    return exists (select 1 from public.events e where e.id = p.event_id and kw.is_member(e.audience_id)
                   and ((not p.is_public and e.audience_id = p.audience_id) or (p.is_public and e.is_public)));
  end if;
  return false;
end $$;

alter table public.posts drop constraint if exists posts_check2;              -- (page_id is null or is_public)
alter table public.posts add constraint posts_no_page check (page_id is null);
alter table public.posts drop constraint posts_kind_check;
alter table public.posts add constraint posts_kind_check
  check (kind in ('status', 'photo', 'link', 'video', 'question', 'checkin', 'note', 'share', 'life_event'));
drop index if exists public.posts_page;
alter table public.posts drop constraint if exists posts_page_id_fkey;    -- the column stays (see header), always null

-- 3. Notifications: v1-only types and objects ---------------------------------------------------------
-- Rebuilt from the live definition so types added by later migrations are kept.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  def := regexp_replace(def, '''(poke|game|question_vote|checkin_tag)''::text,?\s*', '', 'g');
  def := regexp_replace(def, ',\s*\]', ']', 'g');
  execute 'alter table public.notifications drop constraint notifications_type_check';
  execute 'alter table public.notifications add constraint notifications_type_check ' || def;
end $$;
alter table public.notifications drop constraint notifications_object_kind_check;
alter table public.notifications add constraint notifications_object_kind_check
  check (object_kind in ('post', 'comment', 'photo', 'group', 'event', 'conversation', 'profile', 'recovery_request'));

-- 4. Functions that only served these tables ------------------------------------------------------------
drop function if exists public.classic_liked_pages();
drop function if exists public.classic_page_posts();
drop function if exists public.page_like_count(uuid);

-- 5. The tables (their policies, triggers, indexes and Realtime publication entries go with them) ------------
drop table public.poll_votes;
drop table public.page_likes;
drop table public.pages;
drop table public.pokes;
drop table public.game_actions;
drop table public.game_state;
drop function if exists kw.pokes_guard();
drop function if exists kw.pages_guard();
drop function if exists kw.game_state_guard();
drop function if exists kw.game_actions_guard();

-- 6. Data map (docs/v2/03-transparency.md): the tables are gone, so are their rows in the map.
delete from kw.data_map_tables
 where table_name in ('public.pokes', 'public.pages', 'public.page_likes', 'public.poll_votes', 'public.game_state', 'public.game_actions');

-- 7. Nothing left behind.
do $$
declare leftover text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ') into leftover
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'kw')
     and p.prosrc ~ '\m(public\.)?(pokes|page_likes|pages|poll_votes|game_state|game_actions)\M'
     and p.proname not in ('is_reserved_username');   -- reserved handles, not the tables
  if leftover is not null then raise exception 'functions still reference classic tables: %', leftover; end if;
  if exists (select 1 from kw.data_map_columns where table_name in ('public.pokes', 'public.pages')) then
    raise exception 'data map still lists classic tables';
  end if;
end $$;

commit;
