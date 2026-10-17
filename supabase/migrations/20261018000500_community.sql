-- Community (engineer E): groups, events, pages and Kithville.
--
--  1. Container envelopes: groups/events record who signed their encrypted envelope and under
--     which epoch, so members can verify and decrypt it. Container identity is immutable.
--  2. Membership rules for groups/events: only friends can be added or invited; any group member
--     may invite friends (Closed/Secret groups: members see the list and invite); self-requests
--     only for non-secret groups; invites and requests are rate-limited.
--  3. RPCs: ask to join / join an open group, a privacy-only preview for people with a link,
--     key gaps (members lacking an epoch key an admin can deliver) and the rotation check
--     (someone who is no longer a member holds the current key → admins advance the epoch).
--  4. Page walls are written by the page owner only.
--  5. Kithville: encrypted private game state and sealed, rate-limited neighbor actions.

-- ---------------------------------------------------------------------------------------
-- 1. Container envelopes
-- ---------------------------------------------------------------------------------------
alter table public.groups
  add column envelope_by uuid references public.profiles (id) on delete set null,
  add column envelope_epoch int check (envelope_epoch >= 1);
alter table public.events
  add column envelope_by uuid references public.profiles (id) on delete set null,
  add column envelope_epoch int check (envelope_epoch >= 1);

create function kw.groups_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('group_create', 50, interval '1 day');
    new.created_at := now();
    if auth.uid() is not null then new.envelope_by := auth.uid(); end if;
    return new;
  end if;
  if new.id <> old.id or new.creator_id <> old.creator_id or new.audience_id <> old.audience_id
     or new.created_at <> old.created_at then
    raise exception 'group identity is immutable';
  end if;
  -- Closed <-> Secret is fine; Open groups are unencrypted, so they can't switch either way.
  if (new.privacy = 'open') <> (old.privacy = 'open') then
    raise exception 'open groups cannot change to or from encrypted privacy';
  end if;
  if auth.uid() is not null then
    if new.envelope is distinct from old.envelope or new.envelope_epoch is distinct from old.envelope_epoch
       or new.name_public is distinct from old.name_public then
      new.envelope_by := auth.uid();
    else
      new.envelope_by := old.envelope_by;
    end if;
  end if;
  return new;
end $$;
create trigger groups_guard before insert or update on public.groups
  for each row execute function kw.groups_guard();

create function kw.events_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('event_create', 50, interval '1 day');
    new.created_at := now();
    if auth.uid() is not null then new.envelope_by := auth.uid(); end if;
    return new;
  end if;
  if new.id <> old.id or new.host_id <> old.host_id or new.audience_id <> old.audience_id
     or new.created_at <> old.created_at or new.is_public <> old.is_public then
    raise exception 'event identity is immutable';
  end if;
  if auth.uid() is not null then
    if new.envelope is distinct from old.envelope or new.envelope_epoch is distinct from old.envelope_epoch
       or new.public_body is distinct from old.public_body then
      new.envelope_by := auth.uid();
    else
      new.envelope_by := old.envelope_by;
    end if;
  end if;
  return new;
end $$;
create trigger events_guard before insert or update on public.events
  for each row execute function kw.events_guard();

-- ---------------------------------------------------------------------------------------
-- 2. Membership rules for group/event audiences
-- ---------------------------------------------------------------------------------------
create function kw.group_privacy(aud uuid) returns text
language sql stable security definer set search_path = '' as $$
  select privacy from public.groups where audience_id = aud
$$;

-- Any active group member may invite their friends (they get keys from an admin on accept).
create policy "group members invite friends" on public.audience_members
  for insert to authenticated with check (
    kw.is_active() and status = 'invited' and role = 'member' and member_id <> auth.uid()
    and kw.audience_kind(audience_id) = 'group' and kw.is_member(audience_id)
    and kw.is_friend(auth.uid(), member_id) and not kw.is_blocked(auth.uid(), member_id)
  );

create function kw.community_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  k := kw.audience_kind(new.audience_id);
  if k not in ('group', 'event') or auth.uid() is null then return new; end if;
  if new.member_id = auth.uid() then
    if kw.audience_owner(new.audience_id) = auth.uid() then return new; end if;  -- creator's own row
    if new.status = 'active' and k = 'group' and kw.group_privacy(new.audience_id) = 'open' and kw.public_enabled() then
      -- joining an Open group (only reachable through request_group_join; RLS blocks direct inserts)
      new.role := 'member'; new.invited_by := null; new.rsvp := null; new.created_at := now();
      return new;
    end if;
    if new.status <> 'requested' then
      raise exception 'you cannot add yourself' using errcode = '42501';
    end if;
    if k = 'event' or kw.group_privacy(new.audience_id) is distinct from 'closed' then
      raise exception 'this group does not take requests' using errcode = '42501';
    end if;
    if kw.is_blocked(auth.uid(), kw.audience_owner(new.audience_id)) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    perform kw.rate_limit('group_request', 30, interval '1 day');
    new.role := 'member';
    new.invited_by := null;
    new.rsvp := null;
  else
    if not kw.is_friend(auth.uid(), new.member_id) then
      raise exception 'you can only add your friends' using errcode = '42501';
    end if;
    perform kw.rate_limit('community_invite', 500, interval '1 day');
    new.invited_by := auth.uid();
    new.rsvp := null;
  end if;
  new.created_at := now();
  return new;
end $$;
create trigger community_members_guard before insert on public.audience_members
  for each row execute function kw.community_members_guard();

-- ---------------------------------------------------------------------------------------
-- 3. RPCs
-- ---------------------------------------------------------------------------------------

-- Ask to join a Closed group (status 'requested'), or join an Open group directly while the
-- Public audience is enabled. Secret groups take neither. Returns the resulting status.
create function public.request_group_join(g uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare grp record; cur text;
begin
  if auth.uid() is null or not kw.is_active() then raise exception 'not authorised' using errcode = '42501'; end if;
  select id, audience_id, privacy, creator_id into grp from public.groups where id = g;
  if not found or grp.privacy = 'secret' then
    raise exception 'group not found' using errcode = 'P0002';
  end if;
  if kw.is_blocked(auth.uid(), grp.creator_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  select status into cur from public.audience_members where audience_id = grp.audience_id and member_id = auth.uid();
  if found then
    if cur = 'invited' and grp.privacy = 'open' then
      update public.audience_members set status = 'active' where audience_id = grp.audience_id and member_id = auth.uid();
      return 'active';
    end if;
    return cur;
  end if;
  if grp.privacy = 'open' then
    if not kw.public_enabled() then raise exception 'group not found' using errcode = 'P0002'; end if;
    perform kw.rate_limit('group_join', 100, interval '1 day');
    insert into public.audience_members (audience_id, member_id, role, status)
      values (grp.audience_id, auth.uid(), 'member', 'active');
    return 'active';
  end if;
  insert into public.audience_members (audience_id, member_id, role, status)
    values (grp.audience_id, auth.uid(), 'member', 'requested');
  return 'requested';
end $$;

-- What someone holding a link may learn about a group they can't see: only that it exists
-- and is Closed (Secret groups stay invisible; Open groups are visible through RLS anyway).
create function public.group_preview(g uuid) returns table (privacy text, creator_id uuid)
language sql stable security definer set search_path = '' as $$
  select gr.privacy, gr.creator_id from public.groups gr
  where gr.id = g and auth.uid() is not null
    and (gr.privacy = 'closed' or kw.can_see_audience(gr.audience_id))
    and not kw.is_blocked(auth.uid(), gr.creator_id)
$$;

-- Members (active or invited) of a group/event lacking a key for one of the epochs. Only for
-- admins; the admin's device seals the epochs it holds (so new members can read history).
create function public.community_key_gaps(aud uuid)
returns table (recipient_id uuid, epoch int, recipient_kx_pub text)
language sql stable security definer set search_path = '' as $$
  select m.member_id, e.epoch, p.kx_pub
  from public.audiences a
  join public.audience_members m on m.audience_id = a.id and m.status in ('active', 'invited')
  join public.profiles p on p.id = m.member_id
  cross join lateral generate_series(1, a.current_epoch) as e(epoch)
  where a.id = aud and a.kind in ('group', 'event') and kw.is_audience_admin(aud)
    and m.member_id <> auth.uid()
    and not exists (select 1 from public.audience_keys k
                    where k.audience_id = aud and k.epoch = e.epoch and k.recipient_id = m.member_id)
  order by e.epoch desc, m.member_id
  limit 2000
$$;

-- True when someone who is no longer an active/invited member holds the CURRENT epoch key
-- (they left, were removed, or declined). Admins then advance the epoch.
create function public.community_needs_rotation(aud uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.is_audience_admin(aud) and exists (
    select 1 from public.audience_keys k
    join public.audiences a on a.id = k.audience_id
    where k.audience_id = aud and k.epoch = a.current_epoch and a.kind in ('group', 'event')
      and k.recipient_id <> a.owner_id
      and not exists (select 1 from public.audience_members m
                      where m.audience_id = aud and m.member_id = k.recipient_id
                        and m.status in ('active', 'invited')))
$$;

-- ---------------------------------------------------------------------------------------
-- 4. Page walls: only the page owner posts (pages are public; fans like, they don't post).
-- ---------------------------------------------------------------------------------------
create policy "only page owners post on pages" on public.posts
  as restrictive for insert to authenticated
  with check (page_id is null or exists (select 1 from public.pages g where g.id = page_id and g.owner_id = auth.uid()));

create function kw.pages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('page_create', 20, interval '1 day');
    new.created_at := now();
    return new;
  end if;
  if new.id <> old.id or new.owner_id <> old.owner_id or new.created_at <> old.created_at then
    raise exception 'page identity is immutable';
  end if;
  return new;
end $$;
create trigger pages_guard before insert or update on public.pages
  for each row execute function kw.pages_guard();

create index if not exists pages_name on public.pages (lower(name));

-- ---------------------------------------------------------------------------------------
-- 5. Kithville
-- ---------------------------------------------------------------------------------------
-- One encrypted blob per player: encryptBlob(vaultKey, state, "kithville/<user id>").
-- `version` gives optimistic concurrency between tabs/devices.
create table public.game_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  blob text not null check (char_length(blob) < 131072),
  version int not null default 1 check (version >= 1),
  updated_at timestamptz not null default now()
);
alter table public.game_state enable row level security;
create policy "owner reads game state" on public.game_state for select to authenticated
  using (user_id = auth.uid());
create policy "owner creates game state" on public.game_state for insert to authenticated
  with check (user_id = auth.uid() and version = 1);
create policy "owner saves game state" on public.game_state for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner deletes game state" on public.game_state for delete to authenticated
  using (user_id = auth.uid());

create function kw.game_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if new.user_id <> old.user_id then raise exception 'game state identity is immutable'; end if;
    if new.version <> old.version + 1 then
      raise exception 'stale game state' using errcode = '40001';
    end if;
    perform kw.rate_limit('game_save', 5000, interval '1 day');
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger game_state_guard before insert or update on public.game_state
  for each row execute function kw.game_state_guard();

-- Neighbor actions (help = water their crops, gift = an item). The payload is sealed to the
-- recipient and signed by the sender; the server sees only who sent what kind to whom.
create table public.game_actions (
  id uuid primary key,
  from_id uuid not null references public.profiles (id) on delete cascade,
  to_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('help', 'gift')),
  sealed jsonb not null check (octet_length(sealed::text) < 2048),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  check (from_id <> to_id)
);
create index game_actions_to on public.game_actions (to_id, created_at desc);
create index game_actions_from on public.game_actions (from_id, created_at desc);
alter table public.game_actions enable row level security;

create policy "sender and recipient see game actions" on public.game_actions for select to authenticated
  using (auth.uid() in (from_id, to_id));
create policy "send game actions to friends" on public.game_actions for insert to authenticated
  with check (from_id = auth.uid() and kw.is_active() and kw.is_friend(from_id, to_id)
              and not kw.is_blocked(from_id, to_id));
create policy "recipient claims game actions" on public.game_actions for update to authenticated
  using (to_id = auth.uid()) with check (to_id = auth.uid());
create policy "sender or recipient deletes game actions" on public.game_actions for delete to authenticated
  using (auth.uid() in (from_id, to_id));

create function kw.game_actions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('game_action', 100, interval '1 day');
    -- One help and one gift per neighbor per day.
    if exists (select 1 from public.game_actions a
               where a.from_id = new.from_id and a.to_id = new.to_id and a.kind = new.kind
                 and a.created_at > now() - interval '20 hours') then
      raise exception 'already sent today' using errcode = 'P0429';
    end if;
    new.created_at := now();
    new.claimed_at := null;
    return new;
  end if;
  if new.id <> old.id or new.from_id <> old.from_id or new.to_id <> old.to_id or new.kind <> old.kind
     or new.sealed <> old.sealed or new.created_at <> old.created_at then
    raise exception 'only the claim time can change';
  end if;
  if old.claimed_at is not null then raise exception 'already claimed'; end if;
  new.claimed_at := now();
  return new;
end $$;
create trigger game_actions_guard before insert or update on public.game_actions
  for each row execute function kw.game_actions_guard();

alter publication supabase_realtime add table public.game_actions;

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.groups_guard(), kw.events_guard(), kw.community_members_guard(),
  kw.pages_guard(), kw.game_state_guard(), kw.game_actions_guard() from public, anon;
revoke execute on function kw.group_privacy(uuid) from public, anon;
grant execute on function kw.group_privacy(uuid) to authenticated, service_role;
revoke execute on function public.request_group_join(uuid), public.group_preview(uuid),
  public.community_key_gaps(uuid), public.community_needs_rotation(uuid) from public, anon;
grant execute on function public.request_group_join(uuid), public.group_preview(uuid),
  public.community_key_gaps(uuid), public.community_needs_rotation(uuid) to authenticated, service_role;
