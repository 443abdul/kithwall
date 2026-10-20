-- Kithwall 2 phase 3: disappearing, scheduled, edit and unsend (docs/v2/00-brief.md §3 "Safe by default",
-- §4 "New": disappearing content, scheduled posts, edit and unsend everywhere).
--
--  1. Disappearing messages. Each conversation has a timer (off, 1 day, 1 week, 4 weeks, 3 months), stored
--     here because the server has to enforce it. NEW conversations default to 4 weeks (protection is the
--     default); conversations that exist before this migration keep "off" (nothing is deleted) and the app
--     gently suggests turning it on. Every message gets expires_at from the conversation's timer AT INSERT,
--     computed by the database (a client value is ignored). Expired messages are invisible at once (RLS) and
--     deleted by pg_cron within a minute; their media rows go with them and the storage objects are removed by
--     the web cron (/api/cron/ephemeral) from a private trash list.
--     Changing the timer goes through set_conversation_timer(): any member of a 1:1 chat, admins of group and
--     circle chats. It writes a server notice into the thread ("Ann set messages to disappear after 4 weeks")
--     that every member sees. Notices carry no content: the timer is metadata the server already holds.
--  2. Disappearing posts: an optional per-post timer (off, 1 day, 1 week, 1 month) → expires_at, computed by
--     the database from the time the post goes live. Expired posts disappear with their comments, likes,
--     notifications and media.
--  3. Scheduled posts: publish_at. The post is sealed on the author's device as usual and stored now; until
--     publish_at, RLS (and kw.can_read_post, so comments, likes and media too) hides it from everyone except
--     its author. created_at is the publish time, so it lands in the chronological feed where it belongs. A
--     pg_cron job marks due posts published and notifies the author, which fires the push AT PUBLISH TIME.
--  4. Edit and unsend: message edits replace the sealed payload (history is not kept) and set edited_at;
--     unsend wipes the ciphertext at once and leaves a short-lived tombstone so Realtime can tell the other
--     members (Realtime only delivers changes to rows that still exist), then pg_cron removes it. Comments can
--     be edited by their author. No time limits: people control their own words.

-- ---------------------------------------------------------------------------------------
-- 0. Shared bits
-- ---------------------------------------------------------------------------------------
-- Writes the database makes on the user's behalf inside a definer RPC (timer notices, unsend tombstones).
-- Clients cannot reach set_config through the Data API; the flag only lives for the transaction.
create function kw.trusted_write() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('kw.trusted_write', true), '') = 'on'
$$;

-- ---------------------------------------------------------------------------------------
-- 1. Disappearing messages
-- ---------------------------------------------------------------------------------------
alter table public.conversations
  add column disappear_secs int check (disappear_secs is null or disappear_secs in (86400, 604800, 2419200, 7776000)),
  add column disappear_set_at timestamptz;
-- Added without a default so existing conversations stay "off"; only new ones get 4 weeks.
alter table public.conversations alter column disappear_secs set default 2419200;

alter table public.messages
  add column expires_at timestamptz,
  add column edited_at timestamptz,
  add column unsent_at timestamptz,
  add column notice jsonb check (notice is null or (jsonb_typeof(notice) = 'object' and octet_length(notice::text) < 256));
create index messages_expires on public.messages (expires_at) where expires_at is not null;
create index messages_unsent on public.messages (unsent_at) where unsent_at is not null;

create or replace function kw.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare secs int;
begin
  if new.notice is not null and not kw.trusted_write() then
    raise exception 'notices are written by the server' using errcode = '42501';
  end if;
  perform kw.rate_limit('message', 2000, interval '1 day');
  new.created_at := now();
  new.edited_at := null;
  new.unsent_at := null;
  select c.disappear_secs into secs from public.conversations c where c.id = new.conversation_id;
  new.expires_at := case when secs is null then null else now() + make_interval(secs => secs) end;
  update public.conversations set last_message_at = now() where id = new.conversation_id;
  return new;
end $$;

-- Edits: only the sealed payload changes (same id, sender, conversation, epoch, times).
create function kw.messages_edit_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if kw.trusted_write() then return new; end if;
  if new.id <> old.id or new.conversation_id <> old.conversation_id or new.sender_id <> old.sender_id
     or new.epoch <> old.epoch or new.created_at <> old.created_at
     or new.expires_at is distinct from old.expires_at or new.unsent_at is distinct from old.unsent_at
     or new.notice is distinct from old.notice then
    raise exception 'only the text of a message can be edited';
  end if;
  if old.notice is not null or old.unsent_at is not null then
    raise exception 'this message cannot be edited';
  end if;
  perform kw.rate_limit('message_edit', 2000, interval '1 day');
  new.edited_at := now();
  return new;
end $$;
create trigger messages_edit_guard before update on public.messages
  for each row execute function kw.messages_edit_guard();

create policy "sender edits own message" on public.messages for update to authenticated
  using (sender_id = auth.uid() and notice is null and unsent_at is null)
  with check (sender_id = auth.uid() and kw.is_active()
              and kw.is_member(kw.conversation_audience(conversation_id))
              and not kw.dm_blocked(conversation_id));

-- Expired messages are gone for everyone the moment they expire, whatever the cron is doing.
create policy "messages disappear when they expire" on public.messages as restrictive for all to authenticated
  using (expires_at is null or expires_at > now())
  with check (expires_at is null or expires_at > now());

-- Who may change a conversation's timer?
create function kw.can_set_timer(conv uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  select x.audience_id, x.dm_key into c from public.conversations x where x.id = conv;
  if not found or u is null or not kw.is_active(u) or not kw.is_member(c.audience_id, u) then return false; end if;
  if c.dm_key is not null then return not kw.dm_blocked(conv); end if;
  return kw.is_audience_admin(c.audience_id, u);
end $$;

-- Set (secs) or turn off (null) disappearing messages; posts a notice into the thread when it changes.
create function public.set_conversation_timer(conv uuid, secs int) returns int
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); c record;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if secs is not null and secs not in (86400, 604800, 2419200, 7776000) then
    raise exception 'unsupported timer' using errcode = '22023';
  end if;
  if not kw.mfa_ok() or not kw.can_set_timer(conv, uid) then
    raise exception 'not allowed to change this chat''s timer' using errcode = '42501';
  end if;
  select x.id, x.audience_id, x.disappear_secs into c from public.conversations x where x.id = conv for update;
  perform kw.rate_limit('conversation_timer', 100, interval '1 day');
  update public.conversations set disappear_secs = secs, disappear_set_at = now() where id = conv;
  if c.disappear_secs is distinct from secs then
    perform set_config('kw.trusted_write', 'on', true);
    insert into public.messages (id, conversation_id, sender_id, epoch, envelope, notice)
    values (gen_random_uuid(), conv, uid, (select a.current_epoch from public.audiences a where a.id = c.audience_id),
            '{}'::jsonb, jsonb_build_object('kind', 'timer', 'secs', secs));
    perform set_config('kw.trusted_write', 'off', true);
  end if;
  return secs;
end $$;

-- Unsend: wipe the ciphertext and the message's files at once; keep a content-free tombstone for a few
-- minutes so Realtime tells the other members (it drops changes to rows that no longer exist).
create function public.unsend_message(msg uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); m record;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select x.id, x.sender_id, x.notice, x.unsent_at into m from public.messages x where x.id = msg for update;
  if not found then return; end if;
  if m.sender_id <> uid or not kw.mfa_ok() then
    raise exception 'you can only unsend your own messages' using errcode = '42501';
  end if;
  if m.unsent_at is not null then return; end if;
  delete from public.media_objects where message_id = msg;          -- storage objects go to the trash (§5)
  delete from public.message_reactions where message_id = msg;
  perform set_config('kw.trusted_write', 'on', true);
  update public.messages set envelope = '{}'::jsonb, unsent_at = now(), edited_at = now() where id = msg;
  perform set_config('kw.trusted_write', 'off', true);
end $$;

-- Server notices don't push ("Ann set messages to disappear…" is not worth waking a phone for).
drop trigger push_on_message on public.messages;
create trigger push_on_message after insert on public.messages
  for each row when (new.notice is null) execute function kw.push_enqueue('message');

-- Conversation list previews skip tombstones (expired messages are already hidden by RLS).
create or replace function public.conversation_previews(conv_ids uuid[]) returns setof public.messages
language sql stable security invoker set search_path = '' as $$
  select distinct on (m.conversation_id) m.*
    from public.messages m
   where m.conversation_id = any (conv_ids[1:100]) and m.unsent_at is null
   order by m.conversation_id, m.created_at desc
$$;

-- Unread badge for pushes: as in 20261022000500, ignoring expired, unsent and notice rows.
create or replace function kw.push_badge(u uuid) returns int
language sql stable security definer set search_path = '' as $$
  select least(999,
    (select count(*) from public.notifications n where n.recipient_id = u and n.read_at is null)
  + (select count(*) from public.conversations c
      where (exists (select 1 from public.audience_members am
                      where am.audience_id = c.audience_id and am.member_id = u and am.status = 'active')
             or exists (select 1 from public.audiences a where a.id = c.audience_id and a.owner_id = u))
        and c.last_message_at > coalesce((select r.last_read_at from public.conversation_reads r
                                           where r.conversation_id = c.id and r.user_id = u), '-infinity'::timestamptz)
        and exists (select 1 from public.messages m
                     where m.conversation_id = c.id and m.sender_id <> u
                       and m.notice is null and m.unsent_at is null
                       and (m.expires_at is null or m.expires_at > now())
                       and m.created_at > coalesce((select r.last_read_at from public.conversation_reads r
                                                     where r.conversation_id = c.id and r.user_id = u), '-infinity'::timestamptz))))::int
$$;

-- ---------------------------------------------------------------------------------------
-- 2 + 3. Disappearing and scheduled posts
-- ---------------------------------------------------------------------------------------
alter table public.posts
  add column publish_at timestamptz,
  add column disappear_secs int check (disappear_secs is null or disappear_secs in (86400, 604800, 2592000)),
  add column expires_at timestamptz;
create index posts_publish_due on public.posts (publish_at) where publish_at is not null;
create index posts_expires on public.posts (expires_at) where expires_at is not null;
create index posts_scheduled_author on public.posts (author_id, publish_at) where publish_at is not null;

-- Same rules as before (20261017000003), plus: scheduling, publishing and the expiry are set by the server.
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
     or new.event_id is distinct from old.event_id or new.page_id is distinct from old.page_id
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

-- Hidden from everyone but the author until publish_at; hidden from everyone once expired.
create policy "scheduled and expired posts stay hidden" on public.posts as restrictive for select to authenticated
  using ((expires_at is null or expires_at > now())
         and (publish_at is null or publish_at <= now() or author_id = (select auth.uid())));

-- The same rule for everything that hangs off a post (comments, likes, poll votes, media, reports).
create or replace function kw.can_read_post(p uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select author_id, wall_owner_id, is_public, audience_id, publish_at, expires_at into r from public.posts where id = p;
  if not found then return false; end if;
  if r.expires_at is not null and r.expires_at <= now() then return false; end if;
  if u = r.author_id then return true; end if;
  if r.publish_at is not null and r.publish_at > now() then return false; end if;
  if u = r.wall_owner_id then return true; end if;
  if kw.is_blocked(u, r.author_id) or (r.wall_owner_id is not null and kw.is_blocked(u, r.wall_owner_id)) then
    return false;
  end if;
  if r.is_public then return kw.public_enabled(); end if;
  return kw.is_member(r.audience_id, u);
end $$;

-- The home feed leaves out my own still-scheduled posts (they live in "Scheduled" until they go out).
create or replace function public.feed_posts(before timestamptz default 'infinity', page_size int default 20)
returns setof public.posts
language sql stable security invoker set search_path = '' as $$
  select p.* from public.posts p
  where p.created_at < before
    and (p.publish_at is null or p.publish_at <= now())
    and (
      p.author_id = auth.uid() or p.wall_owner_id = auth.uid()
      or p.author_id in (select case when f.user_a = auth.uid() then f.user_b else f.user_a end
                           from public.friendships f
                          where f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b))
      or p.group_id in (select g.id from public.groups g join public.audience_members m on m.audience_id = g.audience_id
                         where m.member_id = auth.uid() and m.status = 'active')
      or p.event_id in (select e.id from public.events e join public.audience_members m on m.audience_id = e.audience_id
                         where m.member_id = auth.uid() and m.status = 'active')
    )
  order by p.created_at desc
  limit least(greatest(page_size, 1), 50)
$$;

-- Notification type for "your scheduled post is now shared". Added to whatever the constraint allows at
-- this point (other migrations may extend it too), rather than restating the whole list.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  if def is not null and position('post_published' in def) = 0 then
    execute 'alter table public.notifications drop constraint notifications_type_check';
    execute 'alter table public.notifications add constraint notifications_type_check '
         || replace(def, 'ARRAY[', 'ARRAY[''post_published''::text, ');
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- 4. Comment edits (the author re-seals the comment under the same id; history is not kept)
-- ---------------------------------------------------------------------------------------
alter table public.comments add column edited_at timestamptz;

create or replace function kw.comments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('comment', 1000, interval '1 day');
  new.created_at := now();
  new.edited_at := null;
  return new;
end $$;

create function kw.comments_edit_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id <> old.id or new.post_id is distinct from old.post_id or new.photo_id is distinct from old.photo_id
     or new.author_id <> old.author_id or new.created_at <> old.created_at then
    raise exception 'only the text of a comment can be edited';
  end if;
  perform kw.rate_limit('comment_edit', 1000, interval '1 day');
  new.edited_at := now();
  return new;
end $$;
create trigger comments_edit_guard before update on public.comments
  for each row execute function kw.comments_edit_guard();

create policy "author edits comment" on public.comments for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and kw.is_active() and kw.can_read_comment_parent(post_id, photo_id));

-- When a post or comment goes (deleted, expired, unsent), its likes and the notifications about it go too.
create function kw.post_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.likes where target_kind = 'post' and target_id = old.id;
  delete from public.notifications where object_kind = 'post' and object_id = old.id;
  return null;
end $$;
create trigger post_gone after delete on public.posts
  for each row execute function kw.post_gone();

create function kw.comment_gone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.likes where target_kind = 'comment' and target_id = old.id;
  return null;
end $$;
create trigger comment_gone after delete on public.comments
  for each row execute function kw.comment_gone();

-- ---------------------------------------------------------------------------------------
-- 5. Media: readable only while the message/post is; storage objects of deleted rows go to a trash list
-- ---------------------------------------------------------------------------------------
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
                     and kw.is_member(c.audience_id, u));
  end if;
  if m.story_id is not null then return kw.can_read_story(m.story_id, u); end if;
  if m.profile_avatar then return kw.is_friend(m.owner_id, u); end if;
  return false;
end $$;

-- Every media row that goes away (cascades from expired/deleted messages and posts included) leaves its
-- storage path here; /api/cron/ephemeral removes the objects with the secret key and forgets the paths.
-- Without a media row nobody can read the object any more (kw.can_read_media), so this is only tidying.
create table kw.media_trash (
  path text primary key,
  trashed_at timestamptz not null default now()
);
revoke all on table kw.media_trash from public, anon, authenticated;

create function kw.media_objects_trash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into kw.media_trash (path) values (old.path) on conflict do nothing;
  return null;
end $$;
create trigger media_objects_trash after delete on public.media_objects
  for each row execute function kw.media_objects_trash();

create function public.trashed_media(max_rows int default 500) returns setof text
language sql stable security definer set search_path = '' as $$
  select t.path from kw.media_trash t
   where not exists (select 1 from public.media_objects m where m.path = t.path)
   order by t.trashed_at
   limit least(greatest(max_rows, 1), 1000)
$$;

create function public.forget_trashed_media(paths text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from kw.media_trash where path = any (paths);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------
-- 6. The clock: publish due posts, remove expired messages/posts and old tombstones. Every minute.
-- ---------------------------------------------------------------------------------------
create function kw.ephemeral_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  -- Scheduled posts that are due: mark published and tell the author (this insert is what pushes).
  for r in
    select p.id, p.author_id from public.posts p
     where p.publish_at is not null and p.publish_at <= now()
       and (p.expires_at is null or p.expires_at > now())
     order by p.publish_at
     limit 500
     for update skip locked
  loop
    update public.posts set publish_at = null where id = r.id;
    insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
    values (r.author_id, r.author_id, 'post_published', 'post', r.id);
  end loop;

  delete from public.messages where id in (
    select m.id from public.messages m where m.expires_at <= now() limit 5000);
  delete from public.messages where id in (
    select m.id from public.messages m where m.unsent_at < now() - interval '10 minutes' limit 5000);
  delete from public.posts where id in (
    select p.id from public.posts p where p.expires_at <= now() limit 1000);
end $$;
select cron.schedule('kithwall-ephemeral', '* * * * *', $$select kw.ephemeral_tick()$$);

-- ---------------------------------------------------------------------------------------
-- 7. Realtime: post edits (and scheduled posts going live) reach readers; RLS filters each change.
-- ---------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts') then
    execute 'alter publication supabase_realtime add table public.posts';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.trusted_write(), kw.messages_edit_guard(), kw.comments_edit_guard(), kw.post_gone(),
  kw.comment_gone(), kw.media_objects_trash(), kw.ephemeral_tick() from public, anon, authenticated;
revoke execute on function kw.can_set_timer(uuid, uuid) from public, anon;
grant execute on function kw.can_set_timer(uuid, uuid) to authenticated, service_role;
revoke execute on function public.set_conversation_timer(uuid, int), public.unsend_message(uuid) from public, anon;
grant execute on function public.set_conversation_timer(uuid, int), public.unsend_message(uuid) to authenticated, service_role;
revoke execute on function public.trashed_media(int), public.forget_trashed_media(text[]) from public, anon, authenticated;
grant execute on function public.trashed_media(int), public.forget_trashed_media(text[]) to service_role;
