-- Kithwall starts over (docs/v2/07-launch.md): every account is created fresh with a passkey or a passphrase,
-- and nothing from the 2010-style app ("Kithwall Classic") or its email + password accounts is carried over.
-- This retires what only existed for that (it was supabase/launch/drop_classic_tables.sql, kept for a cutover
-- that is no longer happening, adjusted to the current schema):
--
--   tables     pokes, pages, page_likes, poll_votes, game_state, game_actions (Pokes, Pages, Questions, Kithville),
--              account_deletion_requests ("I've lost everything", reachable only from the email reset link)
--   columns    posts.page_id (Page walls), push_preferences.pokes
--   rows       posts on Pages and of the classic kinds question / checkin / life_event / game (their comments,
--              likes, notifications and media go with them through the usual cascades and kw.post_gone);
--              notifications of the classic types and about Pages; reports about Pages
--   functions  page_like_count, classic_liked_pages, classic_page_posts (20261027000100_classic_export),
--              the four table guards, request_account_deletion, cancel_account_deletion, due_account_deletions;
--              kw.can_post, kw.posts_guard, kw.can_see_profile, kw.reports_guard, kw.reports_snapshot_meta and
--              kw.auth_maintenance are recreated without them
--   policies   "only page owners post on pages"; the post delete policy is recreated without its Page clause
--   checks     posts: v2 kinds only; notifications: classic types and the 'page' object kind removed; reports:
--              no 'page' target; notice_emails: no 'deletion_scheduled'; data map: no 'legacy' category
--   data map   the seven tables and two columns leave kw.data_map_tables / kw.data_map_columns
-- Kept on purpose:
--   * tag_notices: Kithwall 2 albums write photo tags there (lib/photos.ts).
--   * posts.wall_owner_id: every v2 post on a profile names it (own posts: wall_owner_id = author).
--   * audiences of kind 'list' (friend lists): the kind is part of the audience authorization functions
--     (kw.audience_peers, key authority, roster signing); the app no longer creates lists.
--   * reserved usernames for the old routes (kw.is_reserved_username), so nobody can take @pokes or @games.
-- No pg_cron job, type or storage bucket belongs to these features; the web cron /api/cron/account-deletions
-- that served account_deletion_requests is removed with this change.

-- 1. Content that only existed for classic features ---------------------------------------------
delete from public.posts where page_id is not null or kind in ('question', 'checkin', 'life_event', 'game');
delete from public.notifications
 where type in ('poke', 'game', 'question_vote', 'checkin_tag') or object_kind = 'page';
delete from public.reports where target_kind = 'page';
delete from public.notice_emails where kind = 'deletion_scheduled';

-- 2. Posts: no more Pages or classic kinds -------------------------------------------------------------
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
      -- own wall: own friends / list / self audience, or public
      return p.is_public or (aud.owner_id = auth.uid() and aud.kind in ('friends', 'list', 'self'));
    end if;
    -- friend's wall: must be friends, not blocked, audience = wall owner's friends audience
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

create or replace function kw.posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare scheduled boolean;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('post', 300, interval '1 day');
    new.edited_at := null;
    if new.publish_at is not null and new.publish_at <= now() + interval '1 minute' then new.publish_at := null; end if;
    if new.publish_at is not null then
      if new.publish_at > now() + interval '366 days' then
        raise exception 'posts can be scheduled up to a year ahead' using errcode = '22023';
      end if;
      perform kw.rate_limit('post_schedule', 100, interval '1 day');
      new.created_at := new.publish_at;
    else
      new.created_at := now();
    end if;
    new.expires_at := case when new.disappear_secs is null then null else new.created_at + make_interval(secs => new.disappear_secs) end;
    return new;
  end if;

  if new.id <> old.id or new.author_id <> old.author_id
     or new.wall_owner_id is distinct from old.wall_owner_id or new.group_id is distinct from old.group_id
     or new.event_id is distinct from old.event_id
     or new.kind <> old.kind then
    raise exception 'post identity is immutable';
  end if;

  -- The scheduler (pg_cron, no user): marks a due post published. Nothing else changes.
  if auth.uid() is null and new.publish_at is null and old.publish_at is not null and old.publish_at <= now()
     and new.envelope = old.envelope then
    new.created_at := old.created_at;
    new.edited_at := old.edited_at;
    new.expires_at := old.expires_at;
    return new;
  end if;

  scheduled := old.publish_at is not null and old.publish_at > now();
  if scheduled then
    if new.publish_at is null or new.publish_at <= now() then        -- "publish now"
      new.publish_at := null;
      new.created_at := now();
    elsif new.publish_at is distinct from old.publish_at then         -- rescheduled
      if new.publish_at > now() + interval '366 days' then
        raise exception 'posts can be scheduled up to a year ahead' using errcode = '22023';
      end if;
      new.created_at := new.publish_at;
    else
      new.created_at := old.created_at;
    end if;
    new.edited_at := null;                                            -- nobody has seen it yet
  else
    if new.created_at <> old.created_at
       or (new.publish_at is distinct from old.publish_at and new.publish_at is not null) then
      raise exception 'post identity is immutable';
    end if;
    new.edited_at := case when new.envelope is distinct from old.envelope then now() else old.edited_at end;
  end if;
  new.expires_at := case when new.disappear_secs is null then null else new.created_at + make_interval(secs => new.disappear_secs) end;
  return new;
end $$;

create or replace function kw.reports_snapshot_meta() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.stored_meta is distinct from old.stored_meta then raise exception 'report evidence is immutable'; end if;
    return new;
  end if;
  new.stored_meta := null;
  if new.target_kind = 'post' then
    select jsonb_build_object('id', p.id, 'author_id', p.author_id, 'wall_owner_id', p.wall_owner_id,
             'group_id', p.group_id, 'event_id', p.event_id, 'kind', p.kind,
             'is_public', p.is_public, 'audience_id', p.audience_id, 'epoch', p.epoch)
      into new.stored_meta from public.posts p where p.id = new.target_id;
  elsif new.target_kind = 'comment' then
    select jsonb_build_object('id', c.id, 'author_id', c.author_id, 'post_id', c.post_id, 'photo_id', c.photo_id)
      into new.stored_meta from public.comments c where c.id = new.target_id;
  elsif new.target_kind = 'photo' then
    select jsonb_build_object('id', p.id, 'album_id', p.album_id, 'owner_id', p.owner_id,
             'is_public', p.is_public, 'audience_id', p.audience_id, 'epoch', p.epoch)
      into new.stored_meta from public.photos p where p.id = new.target_id;
  elsif new.target_kind = 'message' then
    select jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'sender_id', m.sender_id,
             'epoch', m.epoch, 'audience_id', c.audience_id)
      into new.stored_meta from public.messages m join public.conversations c on c.id = m.conversation_id
     where m.id = new.target_id;
  end if;
  return new;
end $$;

alter table public.posts drop constraint if exists posts_check2;              -- (page_id is null or is_public)
alter table public.posts drop constraint if exists posts_check;               -- num_nonnulls(wall, group, event, page) = 1
drop index if exists public.posts_page;
alter table public.posts drop column page_id;
alter table public.posts add constraint posts_check check (num_nonnulls(wall_owner_id, group_id, event_id) = 1);
alter table public.posts drop constraint posts_kind_check;
alter table public.posts add constraint posts_kind_check
  check (kind in ('status', 'photo', 'link', 'video', 'note', 'share'));

-- 3. Notifications: classic types and objects -----------------------------------------------------
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

-- 4. Reports: no Pages to report ----------------------------------------------------------------------
alter table public.reports drop constraint reports_target_kind_check;
alter table public.reports add constraint reports_target_kind_check
  check (target_kind in ('post', 'comment', 'photo', 'message', 'profile', 'group', 'event'));

create or replace function kw.reports_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare seen boolean := false; owner uuid; env jsonb;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('report', 50, interval '1 day');
    new.created_at := now();
    -- Workflow and evidence columns are the server's, never the reporter's.
    new.status := 'open'; new.moderator_id := null; new.decision_note := null; new.resolved_at := null;
    new.stored_envelope := null; new.target_owner_id := null;
    if auth.uid() is null then return new; end if;   -- service role (tests, migrations)
    if new.target_kind = 'post' then
      select kw.can_read_post(p.id), p.envelope, p.author_id into seen, env, owner from public.posts p where p.id = new.target_id;
    elsif new.target_kind = 'comment' then
      select kw.can_read_target('comment', c.id), c.envelope, c.author_id into seen, env, owner from public.comments c where c.id = new.target_id;
    elsif new.target_kind = 'photo' then
      select kw.can_read_photo(p.id), p.envelope, p.owner_id into seen, env, owner from public.photos p where p.id = new.target_id;
    elsif new.target_kind = 'message' then
      select kw.is_member(kw.conversation_audience(m.conversation_id)), m.envelope, m.sender_id into seen, env, owner
        from public.messages m where m.id = new.target_id;
    elsif new.target_kind = 'group' then
      select kw.can_see_audience(g.audience_id) or (g.privacy = 'open' and kw.public_enabled()), null::jsonb, kw.audience_owner(g.audience_id)
        into seen, env, owner from public.groups g where g.id = new.target_id;
    elsif new.target_kind = 'event' then
      select kw.can_see_audience(e.audience_id) or (e.is_public and kw.public_enabled())
               or (e.group_id is not null and kw.is_circle_member(e.group_id)),
             null::jsonb, e.host_id
        into seen, env, owner from public.events e where e.id = new.target_id;
    elsif new.target_kind = 'profile' then
      select kw.can_see_profile(p.id), null::jsonb, p.id into seen, env, owner from public.profiles p where p.id = new.target_id;
    end if;
    if not coalesce(seen, false) then
      raise exception 'cannot report what you cannot see' using errcode = '42501';
    end if;
    new.stored_envelope := env;
    new.target_owner_id := owner;
    return new;
  end if;
  if new.status <> old.status and new.status <> 'open' then
    new.moderator_id := auth.uid(); new.resolved_at := now();
  end if;
  if new.reporter_id <> old.reporter_id or new.disclosed is distinct from old.disclosed
     or new.stored_envelope is distinct from old.stored_envelope or new.target_id <> old.target_id
     or new.target_kind <> old.target_kind
     -- (target_owner_id may only go to null: the FK clears it when that account is deleted)
     or (new.target_owner_id is distinct from old.target_owner_id and new.target_owner_id is not null)
     or new.reason <> old.reason or new.details is distinct from old.details or new.created_at <> old.created_at then
    raise exception 'report evidence is immutable';
  end if;
  return new;
end $$;

-- 5. Profiles: owning a Page no longer makes anyone visible -----------------------------------------------
create or replace function kw.can_see_profile(target uuid, viewer uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select viewer is not null and target is not null and (
    target = viewer
    or kw.is_staff(viewer)
    or (not kw.is_blocked(viewer, target) and (
         exists (select 1 from public.profiles p where p.id = target and p.discoverable)
      or exists (select 1 from public.friendships f
                  where f.user_a = least(viewer, target) and f.user_b = greatest(viewer, target))
      or exists (select 1 from public.friendships f1
                   join public.friendships f2
                     on f2.status = 'accepted'
                    and f2.user_a = least(case when f1.user_a = viewer then f1.user_b else f1.user_a end, target)
                    and f2.user_b = greatest(case when f1.user_a = viewer then f1.user_b else f1.user_a end, target)
                  where f1.status = 'accepted' and (f1.user_a = viewer or f1.user_b = viewer))
      or kw.audience_peers(viewer, target)
      or exists (select 1 from public.notifications n where n.recipient_id = viewer and n.actor_id = target)
      or exists (select 1 from public.recovery_shares s
                  where (s.owner_id = viewer and s.trustee_id = target) or (s.owner_id = target and s.trustee_id = viewer))
      or (kw.public_enabled() and exists (select 1 from public.posts x where x.author_id = target and x.is_public))
    ))
  )
$$;

-- 6. Functions that only served the classic tables ---------------------------------------------------------
drop function if exists public.classic_liked_pages();
drop function if exists public.classic_page_posts();
drop function if exists public.page_like_count(uuid);

-- 7. The classic tables (their policies, triggers, indexes and Realtime publication entries go with them) ------
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

alter table public.push_preferences drop column pokes;

-- 8. "I've lost everything": only reachable from a v1 password-reset email (proof of email control). Accounts
--    have no email now; deleting an account needs its identity key (/api/account/delete).
create or replace function kw.auth_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.key_challenges where created_at < now() - interval '1 day';
  delete from public.altcha_spent where spent_at < now() - interval '1 day';
  delete from public.recovery_requests where expires_at < now() - interval '7 days';
  delete from public.reports where status <> 'open' and resolved_at < now() - interval '1 year';
end $$;
revoke execute on function kw.auth_maintenance() from public, anon, authenticated;

drop function if exists public.request_account_deletion();
drop function if exists public.cancel_account_deletion();
drop function if exists public.due_account_deletions(int);
drop table public.account_deletion_requests;

alter table public.notice_emails drop constraint notice_emails_kind_check;
alter table public.notice_emails add constraint notice_emails_kind_check
  check (kind in ('credential_added', 'identity_key_changed', 'recovery_started', 'account_recovered'));

-- 9. Data map (docs/v2/03-transparency.md): the tables and columns are gone, so are their rows in the map.
delete from kw.data_map_tables
 where table_name in ('public.pokes', 'public.pages', 'public.page_likes', 'public.poll_votes', 'public.game_state',
                      'public.game_actions', 'public.account_deletion_requests');
delete from kw.data_map_columns
 where (table_name, column_name) in (('public.posts', 'page_id'), ('public.push_preferences', 'pokes'));
alter table kw.data_map_tables drop constraint data_map_tables_category_check;
alter table kw.data_map_tables add constraint data_map_tables_category_check
  check (category in ('account', 'content', 'social', 'messages', 'activity', 'housekeeping', 'system'));

-- 10. Nothing left behind.
do $$
declare leftover text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ') into leftover
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'kw')
     and (p.prosrc ~ '\m(public\.)?(pokes|page_likes|pages|poll_votes|game_state|game_actions|account_deletion_requests)\M'
          or p.prosrc ~ '\mpage_id\M')
     and p.proname not in ('is_reserved_username');   -- reserved handles, not the tables
  if leftover is not null then raise exception 'functions still reference classic objects: %', leftover; end if;
end $$;
