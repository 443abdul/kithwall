-- Kithwall 2 phase 4: end-to-end encrypted voice and video calls (docs/v2/04-calls.md).
--
-- The server's part is deliberately small. No new tables and no new columns:
--  1. Private Realtime topics for signalling. `call:<conversation id>`: members of that conversation may
--     join and broadcast (offer / answer / ICE / hang-up). `ring:<user id>`: only that person receives;
--     anyone who shares a conversation with them may ring. Every payload is an envelope sealed with the
--     conversation key and signed with the sender's identity key on the device, so Realtime only relays
--     opaque blobs. Broadcasts are not stored.
--  2. A call notice in the thread. start_call() writes a content-free server notice
--     {kind:'call', video} (who called which conversation, when; the same metadata a message already has).
--     It drives the push for people who are offline ("Dan is calling") and becomes the missed-call line.
--     call_answered() adds {ans:true} once someone picks up, so the thread can tell "missed" from "answered".
--     Duration, participants and end time are NOT stored. The notice disappears with the chat's timer.
--  3. turn_quota(): a per-person rate limit for /api/calls/turn (Cloudflare TURN credentials).

-- ---------------------------------------------------------------------------------------
-- 1. Realtime Authorization
-- ---------------------------------------------------------------------------------------
create function kw.call_topic_conversation(topic text) returns uuid
language sql immutable set search_path = '' as $$
  select case when topic ~ '^call:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(topic, 6)::uuid end
$$;

create function kw.ring_owner(topic text) returns uuid
language sql immutable set search_path = '' as $$
  select case when topic ~ '^ring:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(topic, 6)::uuid end
$$;

-- May u take part in a call in this conversation? Active account, member (or owner) of the conversation's
-- audience, and not a one-to-one chat where either person has blocked the other.
create function kw.may_join_call(conv uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select conv is not null and u is not null and kw.is_active(u)
     and exists (select 1 from public.conversations c where c.id = conv)
     and kw.is_member(kw.conversation_audience(conv), u)
     and not kw.dm_blocked(conv)
$$;

-- People in a conversation (owner + active members). Calls are a mesh, so they are capped at 8.
create function kw.conversation_size(conv uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from (
    select a.owner_id as u from public.conversations c join public.audiences a on a.id = c.audience_id where c.id = conv
    union
    select m.member_id from public.conversations c join public.audience_members m on m.audience_id = c.audience_id
     where c.id = conv and m.status = 'active') x
$$;

create policy "kw call: members join" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and kw.may_join_call(kw.call_topic_conversation((select realtime.topic())))
  );

create policy "kw call: members signal" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and kw.may_join_call(kw.call_topic_conversation((select realtime.topic())))
  );

create policy "kw ring: owner receives" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and kw.ring_owner((select realtime.topic())) = (select auth.uid())
  );

create policy "kw ring: co-members ring" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and kw.is_active()
    and kw.shares_conversation((select auth.uid()), kw.ring_owner((select realtime.topic())))
  );

-- ---------------------------------------------------------------------------------------
-- 2. Call notices
-- ---------------------------------------------------------------------------------------
create function public.start_call(conv uuid, video boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); c record; mid uuid := gen_random_uuid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not kw.mfa_ok() or not kw.may_join_call(conv, uid) then
    raise exception 'not allowed to call in this conversation' using errcode = '42501';
  end if;
  if kw.conversation_size(conv) > 8 then
    raise exception 'calls are limited to 8 people' using errcode = '22023';
  end if;
  if kw.conversation_size(conv) < 2 then
    raise exception 'nobody to call' using errcode = '22023';
  end if;
  perform kw.rate_limit('call', 60, interval '1 hour');
  select x.audience_id into c from public.conversations x where x.id = conv;
  perform set_config('kw.trusted_write', 'on', true);
  insert into public.messages (id, conversation_id, sender_id, epoch, envelope, notice)
  values (mid, conv, uid, (select a.current_epoch from public.audiences a where a.id = c.audience_id),
          '{}'::jsonb, jsonb_build_object('kind', 'call', 'video', coalesce(video, false)));
  perform set_config('kw.trusted_write', 'off', true);
  return mid;
end $$;

-- Someone other than the caller picked up (within the ringing window). Idempotent.
create function public.call_answered(msg uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); m record;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select x.id, x.conversation_id, x.sender_id, x.notice, x.created_at into m
    from public.messages x where x.id = msg for update;
  if not found or m.notice is null or m.notice->>'kind' is distinct from 'call' then
    raise exception 'no such call' using errcode = '22023';
  end if;
  if m.sender_id = uid or not kw.may_join_call(m.conversation_id, uid) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if (m.notice->>'ans')::boolean is true then return; end if;
  if m.created_at < now() - interval '3 minutes' then return; end if;
  perform kw.rate_limit('call_answer', 300, interval '1 day');
  perform set_config('kw.trusted_write', 'on', true);
  update public.messages set notice = m.notice || '{"ans":true}'::jsonb where id = msg;
  perform set_config('kw.trusted_write', 'off', true);
end $$;

-- Offline callees get a push ("Dan is calling"); ordinary notices stay silent (20261024000100).
create trigger push_on_call after insert on public.messages
  for each row when (new.notice is not null and new.notice->>'kind' = 'call') execute function kw.push_enqueue('call');

-- ---------------------------------------------------------------------------------------
-- 3. TURN credential quota (called by /api/calls/turn with the caller's JWT)
-- ---------------------------------------------------------------------------------------
create function public.turn_quota() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not kw.is_active() or not kw.mfa_ok() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform kw.rate_limit('turn', 120, interval '1 hour');
end $$;

-- ---------------------------------------------------------------------------------------
-- 4. Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.call_topic_conversation(text), kw.ring_owner(text), kw.may_join_call(uuid, uuid),
  kw.conversation_size(uuid) from public, anon;
grant execute on function kw.call_topic_conversation(text), kw.ring_owner(text), kw.may_join_call(uuid, uuid),
  kw.conversation_size(uuid) to authenticated, service_role;
revoke execute on function public.start_call(uuid, boolean), public.call_answered(uuid), public.turn_quota() from public, anon;
grant execute on function public.start_call(uuid, boolean), public.call_answered(uuid), public.turn_quota()
  to authenticated, service_role;
