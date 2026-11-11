-- Follow, Followers posts, Public posts, Explore and comment controls (docs/v2/10-follow-public.md).
--
-- Kithwall stays connections-only for everyone who does not turn "Let people follow me" on. For those who do:
--
--  * public.follows            who follows whom. Following is instant, needs no approval and is open to every
--                              signed-in person the account has not blocked. Connections count as followers
--                              without a row.
--  * audiences.kind='followers' one per follow-enabled account. Its key is minted and handed out by the owner's
--                              own devices exactly like the 'friends' key (signed epoch records, sealed copies,
--                              rotation when a follower is removed or blocked), so Followers posts stay
--                              end-to-end encrypted. The server lists who follows; it never sees the key.
--  * Public posts              posts.is_public on the author's own profile: signed plaintext, readable by
--                              anyone (also without an account, through the functions at the end). Only
--                              follow-enabled accounts older than app_settings.public_post_min_age_hours.
--  * Explore                   explore_posts(): public posts ranked only from public signals (likes, comments,
--                              age). Nothing about who looked at what is stored anywhere.
--  * Comment controls          privacy_prefs.comment_policy / posts.comment_policy, mention_policy, and
--                              public.restrictions ("restrict": that person's comments on my posts are shown
--                              only to them and to me).
--  * Safety                    a public post is hidden once app_settings.public_report_hide_threshold distinct
--                              accounts reported it, until a moderator restores or removes it; follows and
--                              public posts are rate limited; a block removes follows in both directions.

-- ---------------------------------------------------------------------------------------
-- 1. Operator settings
-- ---------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('public_posts_enabled', 'true'::jsonb),
  ('public_post_min_age_hours', '24'::jsonb),
  ('public_report_hide_threshold', '5'::jsonb)
on conflict (key) do nothing;

create function kw.app_settings_public_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lo int; hi int;
begin
  if new.key = 'public_posts_enabled' and jsonb_typeof(new.value) <> 'boolean' then
    raise exception '% must be true or false', new.key using errcode = '22023';
  end if;
  if new.key in ('public_post_min_age_hours', 'public_report_hide_threshold') then
    if new.key = 'public_post_min_age_hours' then lo := 0; hi := 720; else lo := 1; hi := 1000; end if;
    if not (jsonb_typeof(new.value) = 'number'
            and (new.value #>> '{}')::numeric = trunc((new.value #>> '{}')::numeric)
            and (new.value #>> '{}')::numeric between lo and hi) then
      raise exception '% must be a whole number between % and %', new.key, lo, hi using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger app_settings_public_guard before update on public.app_settings
  for each row execute function kw.app_settings_public_guard();

create function kw.setting_int(k text, fallback int) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(s.value) = 'number' then (s.value #>> '{}')::numeric::int end
                     from public.app_settings s where s.key = k), fallback)
$$;

-- The operator's switch for Public posts on profiles (separate from the older public_audience_enabled, which
-- still governs open circles and public events and stays off).
create function kw.public_posts_on() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value = 'true'::jsonb from public.app_settings s where s.key = 'public_posts_enabled'), false)
$$;

-- ---------------------------------------------------------------------------------------
-- 2. Per-account switches
-- ---------------------------------------------------------------------------------------
-- follow_enabled is public routing data (everyone must be able to tell whether an account can be followed).
-- A follow-enabled account shows a public name: followers cannot read the encrypted profile.
alter table public.profiles add column follow_enabled boolean not null default false;
alter table public.profiles drop constraint directory_name_only_when_discoverable;
alter table public.profiles add constraint public_name_only_when_public
  check (discoverable or follow_enabled or display_name_public is null);
alter table public.profiles add constraint follow_needs_public_name
  check (not follow_enabled or display_name_public is not null);
create index profiles_follow_enabled on public.profiles (id) where follow_enabled;

-- Switches only the owner reads; the database enforces them.
alter table public.privacy_prefs
  add column index_public boolean not null default false,
  add column show_following boolean not null default true,
  add column comment_policy text not null default 'everyone'
    check (comment_policy in ('everyone', 'followers', 'connections', 'nobody')),
  add column mention_policy text not null default 'everyone'
    check (mention_policy in ('everyone', 'followers', 'connections', 'nobody'));

create function kw.shows_following(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.show_following from public.privacy_prefs p where p.user_id = u), true)
$$;

-- ---------------------------------------------------------------------------------------
-- 3. The followers audience
-- ---------------------------------------------------------------------------------------
alter table public.audiences drop constraint audiences_kind_check;
alter table public.audiences add constraint audiences_kind_check
  check (kind in ('friends', 'list', 'group', 'event', 'conversation', 'self', 'followers'));
create unique index audiences_one_followers on public.audiences (owner_id) where kind = 'followers';

-- Created the moment follow is switched on (kept afterwards: old Followers posts stay readable by connections).
create function kw.on_follow_enabled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.follow_enabled and not old.follow_enabled then
    insert into public.audiences (owner_id, kind) values (new.id, 'followers')
      on conflict (owner_id) where kind = 'followers' do nothing;
  end if;
  return null;
end $$;
create trigger on_follow_enabled after update of follow_enabled on public.profiles
  for each row execute function kw.on_follow_enabled();

-- ---------------------------------------------------------------------------------------
-- 4. Follows and restrictions
-- ---------------------------------------------------------------------------------------
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee on public.follows (followee_id, created_at desc);
alter table public.follows enable row level security;

-- Can this account be followed right now?
create function kw.follow_open(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.is_active(u)
     and exists (select 1 from public.profiles p where p.id = u and p.follow_enabled and p.memorialised_at is null)
$$;

-- Does `u` count as a follower of `owner`? Connections always do; an explicit follow counts while the
-- owner lets people follow. Never across a block.
create function kw.is_follower(owner uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select owner is not null and u is not null and not kw.is_blocked(owner, u)
     and (kw.is_friend(owner, u)
          or (exists (select 1 from public.follows f where f.follower_id = u and f.followee_id = owner)
              and exists (select 1 from public.profiles p where p.id = owner and p.follow_enabled)))
$$;

create policy "see follows you are part of, and who your connections follow" on public.follows
  for select to authenticated using (
    follower_id = (select auth.uid()) or followee_id = (select auth.uid())
    or (kw.is_friend((select auth.uid()), follower_id) and kw.shows_following(follower_id))
  );
create policy "follow accounts that allow it" on public.follows
  for insert to authenticated with check (
    follower_id = (select auth.uid()) and kw.is_active() and kw.follow_open(followee_id)
    and not kw.is_blocked(follower_id, followee_id)
  );
create policy "unfollow, or remove a follower" on public.follows
  for delete to authenticated using (follower_id = (select auth.uid()) or followee_id = (select auth.uid()));
select kw.require_mfa('public.follows');
revoke all on public.follows from anon;
grant select, insert, delete on public.follows to authenticated;

create function kw.follows_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('follow', 200, interval '1 day');
  new.created_at := now();
  return new;
end $$;
create trigger follows_guard before insert on public.follows
  for each row execute function kw.follows_guard();

-- Deletes are not published through Realtime (20261028010100_authz_realtime.sql): tell both sides.
create function kw.follows_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.db_notify(old.follower_id, 'follows');
  perform kw.db_notify(old.followee_id, 'follows');
  return null;
end $$;
create trigger follows_deleted after delete on public.follows
  for each row execute function kw.follows_deleted();

-- "Restrict": comments this person writes on my posts are shown only to them and to me. They are not told.
create table public.restrictions (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  target_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, target_id),
  check (owner_id <> target_id)
);
create index restrictions_target on public.restrictions (target_id);
alter table public.restrictions enable row level security;
create policy "owner manages restrictions" on public.restrictions
  for all to authenticated using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and kw.is_active());
select kw.require_mfa('public.restrictions');
revoke all on public.restrictions from anon;
grant select, insert, delete on public.restrictions to authenticated;

create function kw.restrictions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('restrict', 200, interval '1 day');
  new.created_at := now();
  return new;
end $$;
create trigger restrictions_guard before insert on public.restrictions
  for each row execute function kw.restrictions_guard();

create function kw.is_restricted(owner uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restrictions r where r.owner_id = owner and r.target_id = u)
$$;

-- A block ends follows in both directions (and, as before, the connection).
create or replace function kw.on_block() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.friendships
   where user_a = least(new.blocker, new.blocked) and user_b = greatest(new.blocker, new.blocked);
  delete from public.follows
   where (follower_id = new.blocker and followee_id = new.blocked)
      or (follower_id = new.blocked and followee_id = new.blocker);
  return new;
end $$;

-- ---------------------------------------------------------------------------------------
-- 5. Membership, key authority and key deliveries for the followers audience
-- ---------------------------------------------------------------------------------------
create or replace function kw.is_member(aud uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare a record;
begin
  select owner_id, kind into a from public.audiences where id = aud;
  if not found then return false; end if;
  if a.owner_id = u then return true; end if;
  if a.kind = 'self' then return false; end if;
  if kw.is_blocked(a.owner_id, u) and a.kind in ('friends', 'list', 'followers') then return false; end if;
  if a.kind = 'friends' then return kw.is_friend(a.owner_id, u); end if;
  if a.kind = 'followers' then return kw.is_follower(a.owner_id, u); end if;
  return exists (select 1 from public.audience_members m
                 where m.audience_id = aud and m.member_id = u and m.status = 'active');
end $$;

-- Only the owner's devices mint and hand out the followers key (as for friends, self and lists).
create or replace function kw.is_key_authority(aud uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select u is not null and coalesce((
    select case when a.kind in ('friends', 'self', 'list', 'followers') then a.owner_id = u
                else a.owner_id = u
                  or exists (select 1 from public.audience_members m
                              where m.audience_id = a.id and m.member_id = u and m.role = 'admin' and m.status = 'active'
                                and m.grant_sig is not null)
           end
      from public.audiences a where a.id = aud), false)
$$;

-- Which of my audiences still need my current key delivered to someone? Now also: my followers audience,
-- to everyone who follows me (while I let people follow) and to my connections. Capped per call; the app
-- asks again until nothing is pending.
create or replace function public.pending_key_deliveries()
returns table (audience_id uuid, epoch int, recipient_id uuid, recipient_kx_pub text, recipient_sign_pub text)
language sql stable security invoker set search_path = '' as $$
  with mine as (
    select a.id, a.kind, a.owner_id, a.current_epoch from public.audiences a
    where a.owner_id = auth.uid() and a.kind <> 'self'
    union
    select a.id, a.kind, a.owner_id, a.current_epoch from public.audiences a
    join public.audience_members m on m.audience_id = a.id
    where m.member_id = auth.uid() and m.status = 'active'
      and (m.role = 'admin' or a.kind = 'conversation')
  ), entitled as (
    select mine.id as audience_id, mine.current_epoch as epoch,
           case when f.user_a = auth.uid() then f.user_b else f.user_a end as recipient_id
    from mine join public.friendships f
      on mine.kind in ('friends', 'followers') and mine.owner_id = auth.uid()
     and f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b)
    union
    select mine.id, mine.current_epoch, fo.follower_id
    from mine join public.follows fo
      on mine.kind = 'followers' and mine.owner_id = auth.uid() and fo.followee_id = auth.uid()
    where exists (select 1 from public.profiles me where me.id = auth.uid() and me.follow_enabled)
      and not kw.is_blocked(auth.uid(), fo.follower_id)
    union
    select mine.id, mine.current_epoch, m.member_id
    from mine join public.audience_members m
      on m.audience_id = mine.id and m.status = 'active' and mine.kind not in ('friends', 'followers')
    union
    select mine.id, mine.current_epoch, mine.owner_id from mine where mine.kind not in ('friends', 'followers')
  )
  select e.audience_id, e.epoch, e.recipient_id, p.kx_pub, p.sign_pub
  from entitled e
  join public.profiles p on p.id = e.recipient_id
  where e.recipient_id <> auth.uid()
    and not kw.key_delivered(e.audience_id, e.epoch, e.recipient_id)
  limit 2000
$$;

-- Profiles: a follow-enabled account is visible to every signed-in person who is not blocked, and I can see
-- the people who follow me (to hand them my followers key and list them) and the people I restricted.
create or replace function kw.can_see_profile(target uuid, viewer uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select viewer is not null and target is not null and (
    target = viewer
    or kw.is_staff(viewer)
    or (not kw.is_blocked(viewer, target) and (
         exists (select 1 from public.profiles p where p.id = target and (p.discoverable or p.follow_enabled))
      or exists (select 1 from public.follows fo where fo.follower_id = target and fo.followee_id = viewer)
      or exists (select 1 from public.restrictions r where r.owner_id = viewer and r.target_id = target)
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

-- ---------------------------------------------------------------------------------------
-- 6. Posts: Followers and Public
-- ---------------------------------------------------------------------------------------
alter table public.posts
  add column comment_policy text check (comment_policy in ('everyone', 'followers', 'connections', 'nobody')),
  add column public_hidden_at timestamptz,
  add column public_reviewed_at timestamptz;
create index posts_public_recent on public.posts (created_at desc) where is_public and wall_owner_id is not null;

-- Are this author's Public posts on show? (operator switch on, account in good standing, follow turned on:
-- turning follow off takes every public post of the account out of public view until it is turned on again)
create function kw.public_wall_open(author uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.public_posts_on() and kw.is_active(author)
     and exists (select 1 from public.profiles p where p.id = author and p.follow_enabled)
$$;

-- May this account publish a Public post now? Not from a brand-new account.
create function kw.may_post_public(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.public_posts_on()
     and exists (select 1 from public.profiles p
                  where p.id = u and p.follow_enabled
                    and p.created_at <= now() - make_interval(hours => kw.setting_int('public_post_min_age_hours', 24)))
$$;

-- A Public post anyone may read right now, with or without an account.
create function kw.public_post_live(p public.posts) returns boolean
language sql stable security definer set search_path = '' as $$
  select p.is_public and p.wall_owner_id is not null and p.wall_owner_id = p.author_id
     and p.public_hidden_at is null
     and (p.publish_at is null or p.publish_at <= now())
     and (p.expires_at is null or p.expires_at > now())
     and kw.public_wall_open(p.author_id)
$$;

create or replace function kw.can_read_post(p uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select author_id, wall_owner_id, is_public, audience_id, publish_at, expires_at, public_hidden_at into r
    from public.posts where id = p;
  if not found then return false; end if;
  if r.expires_at is not null and r.expires_at <= now() then return false; end if;
  if u = r.author_id then return true; end if;
  if r.publish_at is not null and r.publish_at > now() then return false; end if;
  if u = r.wall_owner_id then return true; end if;
  if kw.is_blocked(u, r.author_id) or (r.wall_owner_id is not null and kw.is_blocked(u, r.wall_owner_id)) then
    return false;
  end if;
  if r.is_public then
    -- Public posts in an open circle or a public event: the older operator switch.
    if r.wall_owner_id is null then return kw.public_enabled(); end if;
    -- Hidden after reports: only its author (above) and moderators until it is reviewed.
    if r.public_hidden_at is not null then return kw.is_staff(u); end if;
    return kw.public_wall_open(r.author_id);
  end if;
  return kw.is_member(r.audience_id, u);
end $$;

create or replace function kw.can_post(p public.posts) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare aud record;
begin
  if p.author_id <> auth.uid() or not kw.is_active() then return false; end if;
  if p.is_public then
    if p.wall_owner_id is not null then
      -- A Public post goes on my own profile, only while I let people follow me.
      return p.wall_owner_id = auth.uid() and kw.may_post_public(auth.uid());
    end if;
    if not kw.public_enabled() then return false; end if;
  else
    select owner_id, kind into aud from public.audiences where id = p.audience_id;
    if not found or not kw.is_member(p.audience_id) then return false; end if;
  end if;

  if p.wall_owner_id is not null then
    if p.wall_owner_id = auth.uid() then
      -- own wall: my connections, a list, only me, or my followers
      return aud.owner_id = auth.uid() and aud.kind in ('friends', 'list', 'self', 'followers');
    end if;
    -- friend's wall: must be friends, not blocked, audience = wall owner's friends audience
    return kw.is_friend(auth.uid(), p.wall_owner_id) and not kw.is_blocked(auth.uid(), p.wall_owner_id)
       and aud.owner_id = p.wall_owner_id and aud.kind = 'friends';
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

-- posts_guard as in 20261024000100_ephemeral.sql, plus: a rate limit on Public posts, and the moderation
-- columns (public_hidden_at / public_reviewed_at) change only through the report trigger and the moderator
-- function below (they set kw.public_moderation for their transaction).
create or replace function kw.posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare scheduled boolean;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('post', 300, interval '1 day');
    if new.is_public and new.wall_owner_id is not null then
      perform kw.rate_limit('public_post', 20, interval '1 day');
    end if;
    new.public_hidden_at := null;
    new.public_reviewed_at := null;
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

  if (new.public_hidden_at is distinct from old.public_hidden_at or new.public_reviewed_at is distinct from old.public_reviewed_at)
     and coalesce(current_setting('kw.public_moderation', true), '') <> 'on' then
    raise exception 'only moderation hides or restores a public post' using errcode = '42501';
  end if;
  -- A post made Public later counts against the same limit as a new Public post.
  if new.is_public and not old.is_public and new.wall_owner_id is not null then
    perform kw.rate_limit('public_post', 20, interval '1 day');
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
  -- An edited public post is new content: a moderator's earlier "this may stay" no longer covers it.
  if new.envelope is distinct from old.envelope then new.public_reviewed_at := null; end if;
  new.expires_at := case when new.disappear_secs is null then null else new.created_at + make_interval(secs => new.disappear_secs) end;
  return new;
end $$;

-- Home feed: also the people I follow (their Followers and Public posts; RLS still decides each row).
create or replace function public.feed_posts(before timestamptz default 'infinity', page_size int default 20)
returns setof public.posts
language sql stable set search_path = '' as $$
  select p.* from public.posts p
  where p.created_at < before
    and (p.publish_at is null or p.publish_at <= now())
    and (
      p.author_id = auth.uid() or p.wall_owner_id = auth.uid()
      or p.author_id in (select case when f.user_a = auth.uid() then f.user_b else f.user_a end
                           from public.friendships f
                          where f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b))
      or (p.wall_owner_id = p.author_id
          and p.author_id in (select fo.followee_id from public.follows fo where fo.follower_id = auth.uid()))
      or p.group_id in (select g.id from public.groups g join public.audience_members m on m.audience_id = g.audience_id
                         where m.member_id = auth.uid() and m.status = 'active')
      or p.event_id in (select e.id from public.events e join public.audience_members m on m.audience_id = e.audience_id
                         where m.member_id = auth.uid() and m.status = 'active')
    )
  order by p.created_at desc
  limit least(greatest(page_size, 1), 50)
$$;

-- ---------------------------------------------------------------------------------------
-- 7. Comment and mention controls
-- ---------------------------------------------------------------------------------------
-- Who may comment on a post: its own setting, else its author's account setting. Circle and event posts are
-- not affected (every member may comment there).
create function kw.may_comment(p_post uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r record; pol text;
begin
  select author_id, wall_owner_id, comment_policy into r from public.posts where id = p_post;
  if not found or u is null then return false; end if;
  if u = r.author_id or u = r.wall_owner_id or r.wall_owner_id is null then return true; end if;
  pol := coalesce(r.comment_policy,
                  (select pp.comment_policy from public.privacy_prefs pp where pp.user_id = r.author_id), 'everyone');
  return case pol
    when 'everyone' then true
    when 'nobody' then false
    when 'connections' then kw.is_friend(r.author_id, u)
    else kw.is_follower(r.author_id, u) end;
end $$;

-- Is this comment shown to `u`? A restricted person's comments are shown to them and to the post's author only.
create function kw.comment_shown(p_post uuid, p_author uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_author is not distinct from u or kw.is_staff(u)
      or not exists (select 1 from public.posts x
                       join public.restrictions r on r.owner_id = x.author_id and r.target_id = p_author
                      where x.id = p_post and x.author_id is distinct from u)
$$;

drop policy "comment on readable items" on public.comments;
create policy "comment on readable items" on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()) and kw.is_active() and kw.can_read_comment_parent(post_id, photo_id)
              and (post_id is null or kw.may_comment(post_id)));
drop policy "read comments on readable items" on public.comments;
create policy "read comments on readable items" on public.comments for select to authenticated
  using (kw.can_read_comment_parent(post_id, photo_id) and (post_id is null or kw.comment_shown(post_id, author_id)));

-- For the app: which of these posts may I comment on (so it can show "Comments are limited" instead of a box).
create function public.comment_gates(p_posts uuid[])
returns table (post_id uuid, can_comment boolean)
language sql stable security definer set search_path = '' as $$
  select x.id, kw.may_comment(x.id)
    from public.posts x
   where x.id = any (p_posts[1:200]) and kw.can_read_post(x.id)
$$;

-- Who may @mention (notify) someone. Accounts that never turned follow on keep today's rule: only people
-- they are connected to or share a circle or chat with.
create function kw.may_mention(actor uuid, target uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare pol text; open_acct boolean;
begin
  if actor is null or target is null or kw.is_blocked(actor, target) then return false; end if;
  pol := coalesce((select pp.mention_policy from public.privacy_prefs pp where pp.user_id = target), 'everyone');
  if pol = 'nobody' then return false; end if;
  if kw.is_friend(actor, target) or kw.shares_audience(actor, target) then return true; end if;
  if pol = 'connections' then return false; end if;
  select p.follow_enabled into open_acct from public.profiles p where p.id = target;
  if not coalesce(open_acct, false) then return false; end if;
  if pol = 'followers' then
    return exists (select 1 from public.follows f where f.follower_id = actor and f.followee_id = target);
  end if;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------
-- 8. Notifications between people who are not connected (a new follower; activity on Followers and
--    Public posts; mentions where the mentioned person allows them)
-- ---------------------------------------------------------------------------------------
do $$
declare def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.notifications'::regclass and c.conname = 'notifications_type_check';
  if def is null then raise exception 'notifications_type_check is missing'; end if;
  if position('''follow''' in def) = 0 then
    def := replace(def, 'ARRAY[', 'ARRAY[''follow''::text, ');
    alter table public.notifications drop constraint notifications_type_check;
    execute 'alter table public.notifications add constraint notifications_type_check ' || def;
  end if;
end $$;

-- May `actor` notify `recipient` although they are not connected?
create function kw.open_notify_ok(p_type text, p_kind text, p_object uuid, p_actor uuid, p_recipient uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_type = 'follow' then
    return exists (select 1 from public.follows f where f.follower_id = p_actor and f.followee_id = p_recipient);
  elsif p_type = 'mention' then
    return kw.may_mention(p_actor, p_recipient);
  elsif p_type in ('like', 'comment', 'share') and p_kind = 'post' then
    -- a Followers or Public post both can read (kw.notification_ok checks the like / comment / repost is real)
    return exists (select 1 from public.posts x
                    where x.id = p_object and x.wall_owner_id is not null
                      and (x.is_public or kw.audience_kind(x.audience_id) = 'followers')
                      and kw.can_read_post(x.id, p_actor) and kw.can_read_post(x.id, p_recipient));
  end if;
  return false;
end $$;

drop policy "notify people you are connected to" on public.notifications;
create policy "notify people you are connected to" on public.notifications for insert to authenticated
  with check (
    actor_id = (select auth.uid()) and recipient_id <> (select auth.uid()) and kw.is_active()
    and not kw.is_blocked(actor_id, recipient_id)
    and (kw.is_friend(actor_id, recipient_id) or kw.shares_audience(actor_id, recipient_id)
         or (type = 'friend_request' and exists (select 1 from public.friendships f
               where f.user_a = least(actor_id, recipient_id) and f.user_b = greatest(actor_id, recipient_id)
                 and f.requested_by = (select auth.uid()) and f.status = 'pending'))
         or kw.open_notify_ok(type, object_kind, object_id, actor_id, recipient_id))
  );

-- kw.notification_ok as in 20261101000300_review_fixes.sql, plus 'follow' and the mention setting.
create or replace function kw.notification_ok(p_type text, p_kind text, p_object uuid, p_actor uuid, p_recipient uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare post record; photo record;
begin
  if p_object is null or p_actor is null or p_recipient is null then return false; end if;
  case p_type
    when 'friend_request' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.friendships f
        where f.user_a = least(p_actor, p_recipient) and f.user_b = greatest(p_actor, p_recipient));
    when 'friend_accept' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.friendships f
        where f.user_a = least(p_actor, p_recipient) and f.user_b = greatest(p_actor, p_recipient) and f.status = 'accepted');
    when 'follow' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.follows f
        where f.follower_id = p_actor and f.followee_id = p_recipient);
    when 'recovery_trustee' then
      return p_kind = 'profile' and p_object = p_actor
         and exists (select 1 from public.recovery_shares s where s.owner_id = p_actor and s.trustee_id = p_recipient);
    when 'group_invite' then
      return p_kind = 'group' and exists (select 1 from public.groups g
        join public.audience_members m on m.audience_id = g.audience_id and m.member_id = p_recipient and m.status in ('invited', 'active')
       where g.id = p_object and kw.is_member(g.audience_id, p_actor));
    when 'event_invite' then
      return p_kind = 'event' and exists (select 1 from public.events e
        join public.audience_members m on m.audience_id = e.audience_id and m.member_id = p_recipient and m.status in ('invited', 'active')
       where e.id = p_object and kw.is_member(e.audience_id, p_actor));
    when 'tag' then
      return p_kind = 'photo' and exists (select 1 from public.tag_notices t
        where t.photo_id = p_object and t.tagged_id = p_recipient and t.tagger_id = p_actor);
    when 'comment', 'like' then
      if p_kind = 'post' then
        select x.id, x.author_id into post from public.posts x where x.id = p_object;
        if not found then return false; end if;
        if p_type = 'like' then
          return p_recipient = post.author_id and exists (select 1 from public.likes l
            where l.target_kind = 'post' and l.target_id = p_object and l.user_id = p_actor);
        end if;
        -- the post's author, or someone whose comment on it the actor replied to
        return exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_actor)
           and (p_recipient = post.author_id
                or exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_recipient));
      elsif p_kind = 'photo' then
        select x.id, x.owner_id into photo from public.photos x where x.id = p_object;
        if not found or p_recipient <> photo.owner_id then return false; end if;
        if p_type = 'like' then
          return exists (select 1 from public.likes l where l.target_kind = 'photo' and l.target_id = p_object and l.user_id = p_actor);
        end if;
        return exists (select 1 from public.comments c where c.photo_id = p_object and c.author_id = p_actor);
      end if;
      return false;
    when 'share' then
      -- the original's author, told by someone who really reposted it
      return p_kind = 'post' and exists (select 1 from public.posts o where o.id = p_object and o.author_id = p_recipient)
         and exists (select 1 from public.posts s where s.shared_post_id = p_object and s.author_id = p_actor and s.kind = 'share');
    when 'mention' then
      -- a post the actor wrote or commented on, which the mentioned person can read and allows mentions from
      -- (the @handle itself is inside the ciphertext, so the server can't check it)
      return p_kind = 'post' and p_recipient <> p_actor and kw.can_read_post(p_object, p_recipient)
         and kw.may_mention(p_actor, p_recipient)
         and (exists (select 1 from public.posts x where x.id = p_object and x.author_id = p_actor)
              or exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_actor));
    else
      return false;
  end case;
end $$;

-- ---------------------------------------------------------------------------------------
-- 9. Reports: a public post is hidden once enough different accounts reported it
-- ---------------------------------------------------------------------------------------
create function kw.reports_public_hide() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n int; need int;
begin
  if new.target_kind <> 'post' then return null; end if;
  if not exists (select 1 from public.posts p
                  where p.id = new.target_id and p.is_public and p.wall_owner_id is not null
                    and p.public_hidden_at is null and p.public_reviewed_at is null) then
    return null;
  end if;
  need := kw.setting_int('public_report_hide_threshold', 5);
  select count(distinct r.reporter_id) into n from public.reports r
   where r.target_kind = 'post' and r.target_id = new.target_id and r.reporter_id is not null;
  if n >= need then
    perform set_config('kw.public_moderation', 'on', true);
    update public.posts set public_hidden_at = now() where id = new.target_id and public_hidden_at is null;
    perform set_config('kw.public_moderation', '', true);
  end if;
  return null;
end $$;
create trigger reports_public_hide after insert on public.reports
  for each row execute function kw.reports_public_hide();

-- A moderator looked at a reported public post and it may stay: show it again, never hide it automatically
-- again, and close the open reports about it. (Removing it instead: mod_remove_content, as for any post.)
create function public.mod_restore_public_post(report uuid, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not kw.is_staff() or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  if note is null or char_length(btrim(note)) = 0 then raise exception 'a decision note is required' using errcode = '22023'; end if;
  select * into r from public.reports where id = report;
  if not found then raise exception 'no such report' using errcode = 'P0002'; end if;
  if r.target_kind <> 'post' or not exists (select 1 from public.posts p where p.id = r.target_id and p.is_public) then
    raise exception 'this report is not about a public post' using errcode = '22023';
  end if;
  perform set_config('kw.public_moderation', 'on', true);
  update public.posts set public_hidden_at = null, public_reviewed_at = now() where id = r.target_id;
  perform set_config('kw.public_moderation', '', true);
  update public.reports set status = 'dismissed', decision_note = left(note, 4000)
   where target_kind = 'post' and target_id = r.target_id and status = 'open';
end $$;

-- ---------------------------------------------------------------------------------------
-- 10. Reading public posts (with or without an account), Explore, search, suggestions
-- ---------------------------------------------------------------------------------------
-- One public post per row, with what a reader needs to check and show it: the author's handle, public name
-- and signing key, and the public counts Explore ranks by. `indexable`: the author lets search engines show
-- their public posts. Nothing is recorded about the caller.
create function kw.public_posts(
  p_viewer uuid, p_sort text, p_kinds text[], p_before timestamptz, p_offset int, p_limit int, p_author uuid, p_id uuid)
returns table (
  id uuid, author_id uuid, wall_owner_id uuid, group_id uuid, event_id uuid, kind text, is_public boolean,
  audience_id uuid, epoch int, shared_post_id uuid, envelope jsonb, created_at timestamptz, edited_at timestamptz,
  comment_policy text, author_username text, author_name text, author_sign_pub text,
  like_count bigint, comment_count bigint, indexable boolean)
language sql stable security definer set search_path = '' as $$
  with live as (
    select p.* from public.posts p
     where p.is_public and p.wall_owner_id is not null and kw.public_post_live(p)
       and (p_id is null or p.id = p_id)
       and (p_author is null or p.author_id = p_author)
       and (p_kinds is null or p.kind = any (p_kinds))
       and (p_before is null or p.created_at < p_before)
       -- "popular" looks at the last two weeks only
       and (p_id is not null or p_sort <> 'popular' or p.created_at > now() - interval '14 days')
       and (p_viewer is null or not kw.is_blocked(p_viewer, p.author_id))
     order by p.created_at desc
     limit case when p_sort = 'popular' and p_id is null then 2000 else least(greatest(p_limit, 1), 50) + greatest(p_offset, 0) end
  ), counted as (
    select l.*,
           (select count(*) from public.likes k where k.target_kind = 'post' and k.target_id = l.id) as like_count,
           (select count(*) from public.comments c
             where c.post_id = l.id and not kw.is_restricted(l.author_id, c.author_id)) as comment_count
      from live l
  )
  select c.id, c.author_id, c.wall_owner_id, c.group_id, c.event_id, c.kind, c.is_public, c.audience_id, c.epoch,
         c.shared_post_id, c.envelope, c.created_at, c.edited_at, c.comment_policy,
         a.username::text, a.display_name_public, a.sign_pub, c.like_count, c.comment_count,
         coalesce((select pp.index_public from public.privacy_prefs pp where pp.user_id = c.author_id), false)
    from counted c join public.profiles a on a.id = c.author_id
   order by case when p_sort = 'popular'
                 then (1 + c.like_count + 2 * c.comment_count)
                      / power(extract(epoch from (now() - c.created_at)) / 3600.0 + 2, 1.5)
            end desc nulls last,
            c.created_at desc, c.id
   offset greatest(p_offset, 0)
   limit least(greatest(p_limit, 1), 50)
$$;

-- Explore: public posts from everyone. p_sort 'recent' (page with p_before) or 'popular' (page with p_offset);
-- p_kinds filters by kind ('status', 'photo', 'video', 'link', 'note', 'share'); p_author: one account.
create function public.explore_posts(
  p_sort text default 'recent', p_kinds text[] default null, p_before timestamptz default null,
  p_offset int default 0, p_limit int default 20, p_author uuid default null)
returns table (
  id uuid, author_id uuid, wall_owner_id uuid, group_id uuid, event_id uuid, kind text, is_public boolean,
  audience_id uuid, epoch int, shared_post_id uuid, envelope jsonb, created_at timestamptz, edited_at timestamptz,
  comment_policy text, author_username text, author_name text, author_sign_pub text,
  like_count bigint, comment_count bigint, indexable boolean)
language sql stable security definer set search_path = '' as $$
  select * from kw.public_posts(auth.uid(), case when p_sort = 'popular' then 'popular' else 'recent' end,
                                p_kinds, p_before, least(greatest(coalesce(p_offset, 0), 0), 1000), coalesce(p_limit, 20), p_author, null)
$$;

-- One public post by id (the shareable link /p/<id>).
create function public.public_post(p_id uuid)
returns table (
  id uuid, author_id uuid, wall_owner_id uuid, group_id uuid, event_id uuid, kind text, is_public boolean,
  audience_id uuid, epoch int, shared_post_id uuid, envelope jsonb, created_at timestamptz, edited_at timestamptz,
  comment_policy text, author_username text, author_name text, author_sign_pub text,
  like_count bigint, comment_count bigint, indexable boolean)
language sql stable security definer set search_path = '' as $$
  select * from kw.public_posts(auth.uid(), 'recent', null, null, 0, 1, null, p_id) where p_id is not null
$$;

-- The comments under a public post, with their authors' handles, public names and signing keys.
create function public.public_comments(p_post uuid)
returns table (
  id uuid, post_id uuid, photo_id uuid, author_id uuid, envelope jsonb, created_at timestamptz, edited_at timestamptz,
  author_username text, author_name text, author_sign_pub text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.post_id, c.photo_id, c.author_id, c.envelope, c.created_at, c.edited_at,
         a.username::text, a.display_name_public, a.sign_pub
    from public.posts p
    join public.comments c on c.post_id = p.id
    join public.profiles a on a.id = c.author_id
   where p.id = p_post and kw.public_post_live(p)
     and (auth.uid() is null or not kw.is_blocked(auth.uid(), p.author_id))
     and (auth.uid() is null or not kw.is_blocked(auth.uid(), c.author_id))
     and (c.author_id is not distinct from auth.uid() or p.author_id is not distinct from auth.uid()
          or not kw.is_restricted(p.author_id, c.author_id))
   order by c.created_at
   limit 500
$$;

-- The people who commented on a Followers or Public post I can read: followers of the same account are
-- strangers to each other, so their profiles are not listable; this gives just what a comment needs.
create function public.comment_authors(p_post uuid)
returns table (id uuid, username text, display_name text, sign_pub text)
language sql stable security definer set search_path = '' as $$
  select distinct a.id, a.username::text, a.display_name_public, a.sign_pub
    from public.posts p
    join public.comments c on c.post_id = p.id
    join public.profiles a on a.id = c.author_id
   where p.id = p_post and auth.uid() is not null and kw.can_read_post(p.id)
     and p.wall_owner_id is not null and (p.is_public or kw.audience_kind(p.audience_id) = 'followers')
     and kw.comment_shown(p.id, c.author_id)
     and not kw.is_blocked(auth.uid(), c.author_id)
   limit 500
$$;

-- Follow facts about one account, for its profile: can it be followed, how many followers (connections
-- included), do I follow it, does it follow me, and its followers audience (so my device can tell whether the
-- key has arrived yet).
create function public.follow_info(p_user uuid)
returns table (follow_enabled boolean, followers bigint, i_follow boolean, follows_me boolean, audience_id uuid, audience_epoch int)
language sql stable security definer set search_path = '' as $$
  select p.follow_enabled,
         case when p.follow_enabled or p.id = auth.uid() then (
           select count(*) from (
             select f.follower_id as u from public.follows f where f.followee_id = p.id and p.follow_enabled
             union
             select case when fr.user_a = p.id then fr.user_b else fr.user_a end from public.friendships fr
              where fr.status = 'accepted' and p.id in (fr.user_a, fr.user_b)) x) end,
         exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id),
         exists (select 1 from public.follows f where f.follower_id = p.id and f.followee_id = auth.uid()),
         a.id, a.current_epoch
    from public.profiles p
    left join public.audiences a on a.owner_id = p.id and a.kind = 'followers' and kw.is_member(a.id)
   where p.id = p_user and auth.uid() is not null and kw.can_see_profile(p.id)
$$;

create function kw.like_escape(s text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- Search by name or @handle. Only accounts that let people follow them are ever returned. The search text
-- is used for this one query and not stored.
create function public.search_accounts(p_q text, p_limit int default 20)
returns table (id uuid, username text, display_name text, followers bigint, i_follow boolean)
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); q text := lower(btrim(regexp_replace(coalesce(p_q, ''), '^\s*@+', '')));
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if char_length(q) < 2 or char_length(q) > 60 then return; end if;
  perform kw.rate_limit('account_search', 300, interval '1 hour');
  return query
    select p.id, p.username::text, p.display_name_public,
           (select count(*) from public.follows f where f.followee_id = p.id),
           exists (select 1 from public.follows f where f.follower_id = uid and f.followee_id = p.id)
      from public.profiles p
     where p.follow_enabled and p.id <> uid and p.memorialised_at is null and kw.is_active(p.id)
       and not kw.is_blocked(uid, p.id) and kw.mfa_ok()
       and (p.username::text like '%' || kw.like_escape(q) || '%'
            or lower(p.display_name_public) like '%' || kw.like_escape(q) || '%')
     order by (p.username::text = q) desc, (p.username::text like kw.like_escape(q) || '%') desc, 4 desc, p.username
     limit least(greatest(coalesce(p_limit, 20), 1), 50);
end $$;

-- Raw material for "Suggested accounts": which follow-enabled accounts my connections follow (only
-- connections who show who they follow). The app counts and ranks on the device; the server is not told
-- which suggestions were shown, opened or dismissed.
create function public.connections_following()
returns table (followee_id uuid, username text, display_name text, follower_id uuid)
language sql stable security definer set search_path = '' as $$
  with friends as (
    select case when f.user_a = auth.uid() then f.user_b else f.user_a end as id
      from public.friendships f
     where f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b)
  )
  select fo.followee_id, p.username::text, p.display_name_public, fo.follower_id
    from friends fr
    join public.follows fo on fo.follower_id = fr.id
    join public.profiles p on p.id = fo.followee_id
   where auth.uid() is not null and kw.mfa_ok()
     and kw.shows_following(fr.id)
     and fo.followee_id <> auth.uid()
     and p.follow_enabled and p.memorialised_at is null and kw.is_active(p.id)
     and not kw.is_blocked(auth.uid(), fo.followee_id)
   limit 5000
$$;

-- ---------------------------------------------------------------------------------------
-- 11. Photos and videos of public posts
-- ---------------------------------------------------------------------------------------
-- Files stay the encrypted objects they always were; a public post's payload carries their keys in the
-- open, so whoever can fetch the object can open it. Signed-in readers already pass kw.can_read_media;
-- this lets people without an account fetch the files of live public posts (and nothing else).
-- (In schema public because people without an account have no access to schema kw.)
create function public.public_media_readable(object_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.media_objects m join public.posts p on p.id = m.post_id
                  where m.path = object_path and kw.public_post_live(p))
$$;
create policy "anyone reads the media of public posts" on storage.objects for select to anon
  using (bucket_id = 'media' and public.public_media_readable(name));

-- ---------------------------------------------------------------------------------------
-- 12. Realtime: the owner's open devices hear about a new follower at once (to hand over the key)
-- ---------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'follows') then
    alter publication supabase_realtime add table public.follows;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- 13. Data map (transparency)
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.follows', 'social', 't.follower_id = $1 or t.followee_id = $1', 'created_at', null,
   'Until you unfollow, the follower is removed, or either account is deleted',
   'Who follows whom. Readable by the server: it has to know who may fetch Followers posts.'),
  ('public.restrictions', 'social', 't.owner_id = $1', 'created_at', null, 'Until you lift the restriction',
   'People whose comments on your posts are shown only to them and to you. They are never told.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.follows', 'follower_id', 'id', null), ('public.follows', 'followee_id', 'id', null),
  ('public.follows', 'created_at', 'time', null),
  ('public.restrictions', 'owner_id', 'id', null), ('public.restrictions', 'target_id', 'id', null),
  ('public.restrictions', 'created_at', 'time', null),
  ('public.profiles', 'follow_enabled', 'plaintext', 'whether people can follow you'),
  ('public.privacy_prefs', 'index_public', 'plaintext', 'search engines may show your public posts'),
  ('public.privacy_prefs', 'show_following', 'plaintext', 'your connections can see who you follow'),
  ('public.privacy_prefs', 'comment_policy', 'plaintext', 'who can comment on your posts'),
  ('public.privacy_prefs', 'mention_policy', 'plaintext', 'who can mention you'),
  ('public.posts', 'comment_policy', 'plaintext', 'who can comment on this post'),
  ('public.posts', 'public_hidden_at', 'time', 'a public post hidden after reports, until a moderator reviews it'),
  ('public.posts', 'public_reviewed_at', 'time', 'a moderator reviewed the public post');
update kw.data_map_columns
   set note = 'text, photos, links, tags. Encrypted, except posts you chose to make Public: those are readable by anyone and only signed'
 where table_name = 'public.posts' and column_name = 'envelope';
update kw.data_map_columns
   set note = 'encrypted comment. On a Public post: readable by anyone and only signed'
 where table_name = 'public.comments' and column_name = 'envelope';

-- ---------------------------------------------------------------------------------------
-- Execute rights (new functions default to PUBLIC; match the rest of the schema)
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.app_settings_public_guard(), kw.on_follow_enabled(), kw.follows_guard(), kw.follows_deleted(),
  kw.restrictions_guard(), kw.reports_public_hide(),
  kw.public_posts(uuid, text, text[], timestamptz, int, int, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function kw.setting_int(text, int), kw.shows_following(uuid), kw.follow_open(uuid), kw.is_follower(uuid, uuid),
  kw.is_restricted(uuid, uuid), kw.public_wall_open(uuid), kw.may_post_public(uuid), kw.may_comment(uuid, uuid),
  kw.comment_shown(uuid, uuid, uuid), kw.may_mention(uuid, uuid), kw.open_notify_ok(text, text, uuid, uuid, uuid),
  kw.like_escape(text)
  from public, anon;
grant execute on function kw.setting_int(text, int), kw.shows_following(uuid), kw.follow_open(uuid), kw.is_follower(uuid, uuid),
  kw.is_restricted(uuid, uuid), kw.public_wall_open(uuid), kw.may_post_public(uuid), kw.may_comment(uuid, uuid),
  kw.comment_shown(uuid, uuid, uuid), kw.may_mention(uuid, uuid), kw.open_notify_ok(text, text, uuid, uuid, uuid),
  kw.like_escape(text)
  to authenticated, service_role;
revoke execute on function kw.public_posts_on(), kw.public_post_live(public.posts) from public, anon;
grant execute on function kw.public_posts_on(), kw.public_post_live(public.posts) to authenticated, service_role;

revoke execute on function public.comment_gates(uuid[]), public.mod_restore_public_post(uuid, text), public.comment_authors(uuid),
  public.follow_info(uuid), public.search_accounts(text, int), public.connections_following()
  from public, anon;
grant execute on function public.comment_gates(uuid[]), public.mod_restore_public_post(uuid, text), public.comment_authors(uuid),
  public.follow_info(uuid), public.search_accounts(text, int), public.connections_following()
  to authenticated, service_role;
-- These serve people without an account too.
revoke execute on function public.explore_posts(text, text[], timestamptz, int, int, uuid), public.public_post(uuid),
  public.public_comments(uuid), public.public_media_readable(text) from public;
grant execute on function public.explore_posts(text, text[], timestamptz, int, int, uuid), public.public_post(uuid),
  public.public_comments(uuid), public.public_media_readable(text) to anon, authenticated, service_role;

-- Every public table must have RLS enabled (same assertion as 20261019000001_integration.sql).
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then raise exception 'RLS is not enabled on: %', missing; end if;
end $$;
