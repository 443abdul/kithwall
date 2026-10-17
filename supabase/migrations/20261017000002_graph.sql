-- Social graph: friendships, blocks, audiences (key groups), audience keys.

create table public.friendships (
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  requested_by uuid not null references public.profiles (id) on delete cascade,
  note jsonb check (note is null or octet_length(note::text) < 4096), -- sealed intro note
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (user_a, user_b),
  check (user_a < user_b),
  check (requested_by in (user_a, user_b))
);
create index friendships_b on public.friendships (user_b);
alter table public.friendships enable row level security;

create table public.blocks (
  blocker uuid not null references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
create index blocks_blocked on public.blocks (blocked);
alter table public.blocks enable row level security;

create function kw.is_friend(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where f.user_a = least(a, b) and f.user_b = greatest(a, b) and f.status = 'accepted'
  )
$$;

create function kw.is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks k
    where (k.blocker = a and k.blocked = b) or (k.blocker = b and k.blocked = a)
  )
$$;

-- Friendships -----------------------------------------------------------------
create policy "parties see friendship" on public.friendships
  for select to authenticated using (auth.uid() in (user_a, user_b));
create policy "request friendship" on public.friendships
  for insert to authenticated with check (
    requested_by = auth.uid() and auth.uid() in (user_a, user_b) and status = 'pending'
    and accepted_at is null and kw.is_active()
    and not kw.is_blocked(user_a, user_b)
  );
create policy "recipient accepts" on public.friendships
  for update to authenticated using (auth.uid() in (user_a, user_b) and requested_by <> auth.uid())
  with check (auth.uid() in (user_a, user_b));
create policy "either party removes" on public.friendships
  for delete to authenticated using (auth.uid() in (user_a, user_b));

create function kw.friendships_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('friend_request', 50, interval '1 day');
    return new;
  end if;
  -- UPDATE: only pending -> accepted; identity columns immutable.
  if new.user_a <> old.user_a or new.user_b <> old.user_b or new.requested_by <> old.requested_by
     or new.created_at <> old.created_at then
    raise exception 'friendship identity is immutable';
  end if;
  if not (old.status = 'pending' and new.status = 'accepted') then
    raise exception 'invalid friendship transition';
  end if;
  new.accepted_at := now();
  return new;
end $$;
create trigger friendships_guard before insert or update on public.friendships
  for each row execute function kw.friendships_guard();

-- Blocks ------------------------------------------------------------------------
create policy "blocker manages blocks" on public.blocks
  for all to authenticated using (blocker = auth.uid()) with check (blocker = auth.uid());

create function kw.on_block() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.friendships
   where user_a = least(new.blocker, new.blocked) and user_b = greatest(new.blocker, new.blocked);
  return new;
end $$;
create trigger on_block after insert on public.blocks
  for each row execute function kw.on_block();

-- Profiles policies (need is_blocked) ----------------------------------------------
create policy "signed-in users see profiles unless blocked" on public.profiles
  for select to authenticated using (id = auth.uid() or not kw.is_blocked(auth.uid(), id));
create policy "create own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid() and status = 'active' and suspended_until is null);
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create function kw.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Moderation fields can only be changed by staff (or the service role).
  if auth.uid() is not null and not kw.is_staff()
     and (new.status is distinct from old.status or new.suspended_until is distinct from old.suspended_until) then
    raise exception 'moderation fields are staff-only';
  end if;
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'profile identity is immutable';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function kw.profiles_guard();

-- Audiences -----------------------------------------------------------------------
-- An audience is a set of people sharing a symmetric key (rotated by epoch).
-- friends: implicit membership = accepted friends of owner. list/group/event/conversation:
-- explicit membership rows. self: owner only.
create table public.audiences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('friends', 'list', 'group', 'event', 'conversation', 'self')),
  current_epoch int not null default 1 check (current_epoch >= 1),
  name_enc jsonb check (name_enc is null or octet_length(name_enc::text) < 4096),
  created_at timestamptz not null default now()
);
create unique index audiences_one_friends on public.audiences (owner_id) where kind = 'friends';
create unique index audiences_one_self on public.audiences (owner_id) where kind = 'self';
alter table public.audiences enable row level security;

create table public.audience_members (
  audience_id uuid not null references public.audiences (id) on delete cascade,
  member_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  status text not null default 'active' check (status in ('active', 'invited', 'requested')),
  rsvp text check (rsvp in ('yes', 'maybe', 'no')),
  invited_by uuid references public.profiles (id) on delete set null,
  last_read_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (audience_id, member_id)
);
create index audience_members_member on public.audience_members (member_id);
alter table public.audience_members enable row level security;

create function kw.audience_owner(aud uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select owner_id from public.audiences where id = aud
$$;

create function kw.is_member(aud uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare a record;
begin
  select owner_id, kind into a from public.audiences where id = aud;
  if not found then return false; end if;
  if a.owner_id = u then return true; end if;
  if a.kind = 'self' then return false; end if;
  if kw.is_blocked(a.owner_id, u) and a.kind in ('friends', 'list') then return false; end if;
  if a.kind = 'friends' then return kw.is_friend(a.owner_id, u); end if;
  return exists (select 1 from public.audience_members m
                 where m.audience_id = aud and m.member_id = u and m.status = 'active');
end $$;

create function kw.is_audience_admin(aud uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audiences a where a.id = aud and a.owner_id = u)
      or exists (select 1 from public.audience_members m
                 where m.audience_id = aud and m.member_id = u and m.role = 'admin' and m.status = 'active')
$$;

-- Can u see that an audience exists / list its members?
create function kw.can_see_audience(aud uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.is_member(aud, u)
      or exists (select 1 from public.audience_members m
                 where m.audience_id = aud and m.member_id = u and m.status in ('invited', 'requested'))
$$;

create policy "members see audience" on public.audiences
  for select to authenticated using (kw.can_see_audience(id));
create policy "create own audience" on public.audiences
  for insert to authenticated with check (owner_id = auth.uid() and current_epoch = 1);
create policy "owner updates audience" on public.audiences
  for update to authenticated using (kw.is_audience_admin(id)) with check (kw.is_audience_admin(id));
create policy "owner deletes non-default audience" on public.audiences
  for delete to authenticated using (owner_id = auth.uid() and kind in ('list', 'group', 'event'));

create function kw.audiences_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_id <> old.owner_id or new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception 'audience identity is immutable';
  end if;
  if new.current_epoch not in (old.current_epoch, old.current_epoch + 1) then
    raise exception 'epoch may only advance by one';
  end if;
  return new;
end $$;
create trigger audiences_guard before update on public.audiences
  for each row execute function kw.audiences_guard();

-- Membership rows: admins add/invite; people may request to join or accept invites;
-- people may leave; admins remove.
create policy "see co-members" on public.audience_members
  for select to authenticated using (member_id = auth.uid() or kw.is_member(audience_id));
create policy "admins add members; people request to join" on public.audience_members
  for insert to authenticated with check (
    kw.is_active() and (
      (kw.is_audience_admin(audience_id) and status in ('active', 'invited') and role = 'member'
         and not kw.is_blocked(auth.uid(), member_id))
      or (member_id = auth.uid() and status = 'requested' and role = 'member')
      or (member_id = auth.uid() and kw.audience_owner(audience_id) = auth.uid())
      -- conversation members can add people they are friends with
      or (exists (select 1 from public.audiences a where a.id = audience_id and a.kind = 'conversation')
          and kw.is_member(audience_id) and kw.is_friend(auth.uid(), member_id)
          and status = 'active' and role = 'member')
    )
  );
create policy "update own membership or admin updates" on public.audience_members
  for update to authenticated using (member_id = auth.uid() or kw.is_audience_admin(audience_id))
  with check (member_id = auth.uid() or kw.is_audience_admin(audience_id));
create policy "leave or admin removes" on public.audience_members
  for delete to authenticated using (member_id = auth.uid() or kw.is_audience_admin(audience_id));

create function kw.audience_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.audience_id <> old.audience_id or new.member_id <> old.member_id then
    raise exception 'membership identity is immutable';
  end if;
  if not kw.is_audience_admin(new.audience_id) then
    -- Non-admins may only: accept an invite, set their RSVP, mark read.
    if new.role <> old.role then raise exception 'only admins change roles'; end if;
    if new.status <> old.status and not (old.status = 'invited' and new.status = 'active') then
      raise exception 'only admins approve requests';
    end if;
  end if;
  return new;
end $$;
create trigger audience_members_guard before update on public.audience_members
  for each row execute function kw.audience_members_guard();

-- Audience keys: the epoch key sealed to one recipient (signed by the sealer).
create table public.audience_keys (
  audience_id uuid not null references public.audiences (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  sealed_by uuid not null references public.profiles (id) on delete cascade,
  sealed jsonb not null check (octet_length(sealed::text) < 2048),
  created_at timestamptz not null default now(),
  primary key (audience_id, epoch, recipient_id)
);
create index audience_keys_recipient on public.audience_keys (recipient_id);
alter table public.audience_keys enable row level security;

create policy "recipient and sealer read keys" on public.audience_keys
  for select to authenticated using (recipient_id = auth.uid() or sealed_by = auth.uid());
create policy "deliver keys to members" on public.audience_keys
  for insert to authenticated with check (
    sealed_by = auth.uid()
    and kw.is_member(audience_id)                               -- sealer holds the key
    and (kw.is_member(audience_id, recipient_id)                -- recipient is entitled
         or exists (select 1 from public.audience_members m     -- or invited (gets key on accept)
                    where m.audience_id = audience_keys.audience_id
                      and m.member_id = recipient_id and m.status = 'invited'))
    and (kw.audience_owner(audience_id) = auth.uid()            -- owner delivers any key
         or kw.is_audience_admin(audience_id)
         or exists (select 1 from public.audiences a
                    where a.id = audience_id and a.kind = 'conversation'))
  );
create policy "sealer replaces own delivery" on public.audience_keys
  for delete to authenticated using (sealed_by = auth.uid() or kw.audience_owner(audience_id) = auth.uid());

-- Create the default audiences when a profile is created.
create function kw.on_profile_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audiences (owner_id, kind) values (new.id, 'friends'), (new.id, 'self');
  return new;
end $$;
create trigger on_profile_created after insert on public.profiles
  for each row execute function kw.on_profile_created();

-- Which of my audiences still need my current key delivered to someone?
-- Returns friends (for my friends audience) and active members (for audiences I administer)
-- lacking a key for the current epoch.
create function public.pending_key_deliveries()
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
      on mine.kind = 'friends' and f.status = 'accepted' and auth.uid() in (f.user_a, f.user_b)
    union
    select mine.id, mine.current_epoch, m.member_id
    from mine join public.audience_members m
      on m.audience_id = mine.id and m.status = 'active' and mine.kind <> 'friends'
    union
    select mine.id, mine.current_epoch, mine.owner_id from mine where mine.kind <> 'friends'
  )
  select e.audience_id, e.epoch, e.recipient_id, p.kx_pub, p.sign_pub
  from entitled e
  join public.profiles p on p.id = e.recipient_id
  where e.recipient_id <> auth.uid()
    and not exists (select 1 from public.audience_keys k
                    where k.audience_id = e.audience_id and k.epoch = e.epoch
                      and k.recipient_id = e.recipient_id)
$$;
