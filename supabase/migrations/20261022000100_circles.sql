-- Kithwall 2 · Circles, events, albums & notes (phase 2).
--
-- Circles are v1 groups (privacy 'secret': invite-only, never listed, no join requests). Their feed,
-- notes (posts of kind 'note') and membership/rotation already work on the v1 schema. This migration
-- adds the two things v1 could not express:
--
--  1. Events inside a circle: events.group_id (optional, immutable). Active circle members can see a
--     circle event's row (so it shows up in the circle) and add themselves to its guest list, and any
--     guest may invite other active circle members even when they are not connected (v1 only allowed
--     inviting friends). Details stay end-to-end encrypted to the event's own audience: a member who
--     joins later waits for a host/admin device to deliver the key (community_key_gaps).
--  2. Albums shared with a circle: albums/photos may be encrypted to a group audience the owner is an
--     active member of (v1 allowed only the owner's friends / list / self audiences).

-- ---------------------------------------------------------------------------------------
-- 1. Circle events
-- ---------------------------------------------------------------------------------------
alter table public.events add column if not exists group_id uuid references public.groups (id) on delete cascade;
create index if not exists events_group on public.events (group_id, created_at desc) where group_id is not null;

-- Is `u` an active member of the circle (group) with id `g`?
create function kw.is_circle_member(g uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.groups gr where gr.id = g and kw.is_member(gr.audience_id, u))
$$;

-- The circle an event audience belongs to (null for ordinary events).
create function kw.event_circle(aud uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select e.group_id from public.events e where e.audience_id = aud
$$;

create function kw.events_circle_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.group_id is distinct from old.group_id then
      raise exception 'an event''s circle is immutable';
    end if;
    return new;
  end if;
  if new.group_id is not null then
    if new.is_public then
      raise exception 'circle events are private' using errcode = '42501';
    end if;
    if auth.uid() is not null and not kw.is_circle_member(new.group_id) then
      raise exception 'only circle members can add events to a circle' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger events_circle_guard before insert or update on public.events
  for each row execute function kw.events_circle_guard();

create policy "circle members see circle events" on public.events
  for select to authenticated using (group_id is not null and kw.is_circle_member(group_id));

-- Circle members may add themselves to a circle event's guest list (active, as a member).
create policy "circle members join circle events" on public.audience_members
  for insert to authenticated with check (
    kw.is_active() and member_id = auth.uid() and status = 'active' and role = 'member'
    and kw.audience_kind(audience_id) = 'event'
    and kw.event_circle(audience_id) is not null and kw.is_circle_member(kw.event_circle(audience_id))
  );

-- Same rules as 20261018000500_community.sql, plus the circle-event branch at the top.
create or replace function kw.community_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; circ uuid;
begin
  k := kw.audience_kind(new.audience_id);
  if k not in ('group', 'event') or auth.uid() is null then return new; end if;
  if k = 'event' then
    circ := kw.event_circle(new.audience_id);
    if circ is not null and kw.audience_owner(new.audience_id) <> new.member_id
       and kw.is_circle_member(circ, new.member_id) then
      if new.member_id = auth.uid() then
        -- joining a circle event you can see (RLS: "circle members join circle events")
        new.status := 'active'; new.role := 'member';
        new.invited_by := null; new.rsvp := null; new.created_at := now();
        return new;
      end if;
      -- a guest/admin adds another member of the same circle (connection or not)
      if not kw.is_circle_member(circ) then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      if kw.is_blocked(auth.uid(), new.member_id) then
        raise exception 'not allowed' using errcode = '42501';
      end if;
      perform kw.rate_limit('community_invite', 500, interval '1 day');
      new.invited_by := auth.uid();
      new.rsvp := null;
      new.created_at := now();
      return new;
    end if;
  end if;
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

-- Event guests may add other circle members to a circle event (the v1 policy only lets admins add).
create policy "circle event guests invite circle members" on public.audience_members
  for insert to authenticated with check (
    kw.is_active() and member_id <> auth.uid() and status = 'active' and role = 'member'
    and kw.audience_kind(audience_id) = 'event' and kw.is_member(audience_id)
    and kw.event_circle(audience_id) is not null
    and kw.is_circle_member(kw.event_circle(audience_id), member_id)
    and not kw.is_blocked(auth.uid(), member_id)
  );

-- ---------------------------------------------------------------------------------------
-- 2. Albums and photos shared with a circle
-- ---------------------------------------------------------------------------------------
create or replace function kw.can_write_item(owner uuid, is_public boolean, aud uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select owner = auth.uid() and kw.is_active()
     and case when is_public then kw.public_enabled()
              else exists (select 1 from public.audiences a where a.id = aud and (
                     (a.owner_id = auth.uid() and a.kind in ('friends', 'list', 'self'))
                     or (a.kind = 'group' and kw.is_member(aud)))) end
$$;

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.events_circle_guard(), kw.community_members_guard() from public, anon;
revoke execute on function kw.is_circle_member(uuid, uuid), kw.event_circle(uuid) from public, anon;
grant execute on function kw.is_circle_member(uuid, uuid), kw.event_circle(uuid) to authenticated, service_role;
