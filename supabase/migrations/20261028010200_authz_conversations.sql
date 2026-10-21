-- Security review D2 + L1 (docs/v2/06-security-review.md).
--
-- D2: any user could create a conversation, add ANY non-blocking user as an active member and then
-- message, call, ring and push them, bypassing privacy_prefs.requests_from = 'nobody'. Conversation
-- membership is what calls (kw.may_join_call / kw.shares_conversation), ringing, inbox signals and
-- notifications (kw.shares_audience) trust, so the gate goes on membership itself:
--   * someone other than yourself may be added to a chat only by a person who is CONNECTED to them
--     (accepted friendship), or who shares a circle with them AND whom their requests_from setting
--     allows (kw.may_request: 'everyone' / 'mutual' yes, 'nobody' no). Blocks always win.
--   * public.create_conversation() creates a DM or group chat in one transaction with the same check
--     (the client used three separate inserts, which could leave half-made chats behind).
--   * notifications of type recovery_request are server-only (start_handle_recovery), and
--     recovery_trustee needs a real trusted-friend share, so nobody can fake "help me recover" prompts.
-- L1: nobody may add themselves to someone else's conversation or list (as 'requested' or otherwise).
--     Join requests stay possible only for closed groups (kw.community_members_guard).

-- Do a and b share a circle (owner or active member of the same group audience)?
create function kw.shares_circle(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with mine as (
    select m.audience_id from public.audience_members m
      join public.audiences x on x.id = m.audience_id and x.kind = 'group'
     where m.member_id = a and m.status = 'active'
    union
    select x.id from public.audiences x where x.owner_id = a and x.kind = 'group'
  )
  select a is not null and b is not null and a <> b and exists (
    select 1 from mine join public.audiences x on x.id = mine.audience_id
     where x.owner_id = b
        or exists (select 1 from public.audience_members m
                    where m.audience_id = mine.audience_id and m.member_id = b and m.status = 'active'))
$$;

-- May `adder` put `target` into a chat (and so be able to message, call and ring them)?
create function kw.may_add_to_chat(adder uuid, target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select adder is not null and target is not null and adder <> target
     and not kw.is_blocked(adder, target)
     and (kw.is_friend(adder, target)
          or (kw.shares_circle(adder, target) and kw.may_request(adder, target)))
$$;

-- Membership rows of private audiences (conversation, list, friends, self). Groups and events are
-- checked by kw.community_members_guard. Service role / migrations (no auth.uid()) are trusted.
create function kw.private_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; owner uuid;
begin
  if auth.uid() is null then return new; end if;
  select a.kind, a.owner_id into k, owner from public.audiences a where a.id = new.audience_id;
  if k is null or k in ('group', 'event') then return new; end if;
  if k in ('friends', 'self') then
    raise exception 'this audience has no member rows' using errcode = '42501';
  end if;
  if new.member_id = auth.uid() then
    if owner = auth.uid() then return new; end if;   -- the creator's own row
    raise exception 'you cannot add yourself to this' using errcode = '42501';
  end if;
  if k = 'list' then
    if owner is distinct from auth.uid() or not kw.is_friend(owner, new.member_id) then
      raise exception 'lists can only hold your connections' using errcode = '42501';
    end if;
    return new;
  end if;
  -- conversation
  if not kw.may_add_to_chat(auth.uid(), new.member_id) then
    raise exception 'not_connected' using errcode = '42501',
      hint = 'You can only add people you are connected with (or who share a circle with you and accept requests).';
  end if;
  if new.status <> 'active' or new.role <> 'member' then
    raise exception 'chat members are added as active members' using errcode = '42501';
  end if;
  perform kw.rate_limit('chat_add', 500, interval '1 day');
  new.invited_by := auth.uid();
  new.created_at := now();
  return new;
end $$;
create trigger private_members_guard before insert on public.audience_members
  for each row execute function kw.private_members_guard();

-- ---------------------------------------------------------------------------------------
-- One call to start a chat. The audience (and its first key) is created by the client first
-- (keyring.createAudience); this adds the members and the conversation atomically.
-- ---------------------------------------------------------------------------------------
create function public.create_conversation(p_audience uuid, p_members uuid[], p_dm boolean default false)
returns public.conversations
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  a record;
  ids uuid[];
  m uuid;
  dk text;
  c public.conversations;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not kw.is_active() or not kw.mfa_ok() then raise exception 'not allowed' using errcode = '42501'; end if;
  select x.id, x.owner_id, x.kind into a from public.audiences x where x.id = p_audience for update;
  if not found or a.owner_id <> uid or a.kind <> 'conversation' then
    raise exception 'not your new chat' using errcode = '42501';
  end if;
  if exists (select 1 from public.conversations x where x.audience_id = p_audience) then
    raise exception 'this chat already exists' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct v), '{}') into ids from unnest(coalesce(p_members, '{}')) v where v is not null and v <> uid;
  if cardinality(ids) = 0 then raise exception 'choose at least one person' using errcode = '22023'; end if;
  if cardinality(ids) > 49 then raise exception 'too many people' using errcode = '22023'; end if;
  if p_dm and cardinality(ids) <> 1 then raise exception 'a one-to-one chat has one other person' using errcode = '22023'; end if;
  foreach m in array ids loop
    if not kw.may_add_to_chat(uid, m) then
      raise exception 'not_connected' using errcode = '42501',
        hint = 'You can only add people you are connected with (or who share a circle with you and accept requests).';
    end if;
  end loop;
  insert into public.audience_members (audience_id, member_id, role, status, invited_by)
    values (p_audience, uid, 'admin', 'active', uid) on conflict do nothing;
  insert into public.audience_members (audience_id, member_id, role, status, invited_by)
    select p_audience, v, 'member', 'active', uid from unnest(ids) v
    on conflict do nothing;
  if p_dm then
    dk := least(uid, ids[1])::text || ':' || greatest(uid, ids[1])::text;
  end if;
  insert into public.conversations (audience_id, created_by, dm_key) values (p_audience, uid, dk) returning * into c;
  return c;
end $$;

-- ---------------------------------------------------------------------------------------
-- Notifications that only the server (or a real trusted-friend setup) may produce.
-- ---------------------------------------------------------------------------------------
create policy "recovery notices are not forgeable" on public.notifications as restrictive
  for insert to authenticated with check (
    type <> 'recovery_request'
    and (type <> 'recovery_trustee' or exists (select 1 from public.recovery_shares s
                                                 where s.owner_id = actor_id and s.trustee_id = recipient_id))
  );

revoke execute on function kw.shares_circle(uuid, uuid), kw.may_add_to_chat(uuid, uuid), kw.private_members_guard()
  from public, anon;
grant execute on function kw.shares_circle(uuid, uuid), kw.may_add_to_chat(uuid, uuid) to authenticated, service_role;
revoke execute on function kw.private_members_guard() from authenticated;
revoke execute on function public.create_conversation(uuid, uuid[], boolean) from public, anon;
grant execute on function public.create_conversation(uuid, uuid[], boolean) to authenticated, service_role;
