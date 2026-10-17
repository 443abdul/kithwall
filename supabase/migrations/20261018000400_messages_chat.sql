-- Messages & chat (spec §3.10): conversation re-keying after membership changes, ownership
-- hand-over when the owner leaves, conversation rate limits, and private Realtime "inbox"
-- channels for presence and typing (Realtime Authorization on realtime.messages).
--
-- Key authority: the conversation OWNER is the only device that rotates a conversation key.
-- (A single authority avoids two devices minting different keys for the same epoch.) The
-- owner is always a member; when the owner leaves, ownership passes to a remaining member,
-- whose device then rotates.

-- ---------------------------------------------------------------------------------------
-- 1. Re-key marker. Set by the database whenever a conversation's membership changes;
--    cleared when the owner advances the epoch. Membership is routing metadata the server
--    already knows, so this flag reveals nothing new.
-- ---------------------------------------------------------------------------------------
alter table public.conversations add column rekey_needed boolean not null default false;

create index if not exists audiences_owner_kind on public.audiences (owner_id, kind);

create function kw.conversation_members_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare aud uuid;
begin
  if tg_op = 'DELETE' then aud := old.audience_id; else aud := new.audience_id; end if;
  if kw.audience_kind(aud) = 'conversation' then
    update public.conversations set rekey_needed = true where audience_id = aud and not rekey_needed;
  end if;
  return null;
end $$;
create trigger conversation_members_changed after insert or delete on public.audience_members
  for each row execute function kw.conversation_members_changed();

create function kw.conversation_rekeyed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'conversation' and new.current_epoch > old.current_epoch then
    update public.conversations set rekey_needed = false where audience_id = new.id and rekey_needed;
  end if;
  return null;
end $$;
create trigger conversation_rekeyed after update of current_epoch on public.audiences
  for each row execute function kw.conversation_rekeyed();

-- ---------------------------------------------------------------------------------------
-- 2. Ownership hand-over. Audience identity stays immutable, except that the current owner of
--    a CONVERSATION may hand it to an active member (used when the owner leaves).
-- ---------------------------------------------------------------------------------------
create or replace function kw.audiences_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception 'audience identity is immutable';
  end if;
  if new.owner_id <> old.owner_id then
    if not (old.kind = 'conversation'
            and (auth.uid() is null or old.owner_id = auth.uid())
            and exists (select 1 from public.audience_members m
                        where m.audience_id = new.id and m.member_id = new.owner_id and m.status = 'active')) then
      raise exception 'audience identity is immutable';
    end if;
  end if;
  if new.current_epoch not in (old.current_epoch, old.current_epoch + 1) then
    raise exception 'epoch may only advance by one';
  end if;
  return new;
end $$;

-- Leave a group conversation. If the owner leaves, ownership (and the job of rotating the key)
-- passes to an admin or the longest-standing member; the last person out deletes it.
create function public.leave_conversation(conv uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  a record;
  succ uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select x.id, x.owner_id, c.dm_key into a
    from public.conversations c join public.audiences x on x.id = c.audience_id
   where c.id = conv
   for update of x;
  if not found or not kw.is_member(a.id, uid) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if a.dm_key is not null then
    raise exception 'one-to-one conversations can be archived, not left' using errcode = '22023';
  end if;
  if a.owner_id = uid then
    select m.member_id into succ from public.audience_members m
     where m.audience_id = a.id and m.member_id <> uid and m.status = 'active'
     order by (m.role = 'admin') desc, m.created_at, m.member_id
     limit 1;
    if succ is null then
      delete from public.audiences where id = a.id;   -- cascades to the conversation, messages, keys
      return;
    end if;
    update public.audience_members set role = 'admin' where audience_id = a.id and member_id = succ;
    update public.audiences set owner_id = succ where id = a.id;
  end if;
  delete from public.audience_members where audience_id = a.id and member_id = uid;
end $$;

-- ---------------------------------------------------------------------------------------
-- 3. Abuse limits: starting conversations (including with non-friends) is rate-limited.
-- ---------------------------------------------------------------------------------------
create function kw.conversations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('conversation', 200, interval '1 day');
  new.created_at := now();
  new.last_message_at := now();
  new.rekey_needed := false;
  return new;
end $$;
create trigger conversations_guard before insert on public.conversations
  for each row execute function kw.conversations_guard();

-- ---------------------------------------------------------------------------------------
-- 4. Private Realtime inboxes (presence + typing). Each user listens on ONE private broadcast
--    channel "inbox:<their uuid>". Only they may receive on it. Friends may send presence
--    heartbeats to it and conversation co-members may send typing signals. Payloads carry no
--    content (and are signed by the sender's identity key; receivers verify).
-- ---------------------------------------------------------------------------------------
create function kw.inbox_owner(topic text) returns uuid
language sql immutable set search_path = '' as $$
  select case when topic ~ '^inbox:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(topic, 7)::uuid end
$$;

-- Do a and b both belong (owner or active member) to at least one conversation?
create function kw.shares_conversation(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with mine as (
    select x.id from public.audiences x where x.owner_id = a and x.kind = 'conversation'
    union
    select m.audience_id from public.audience_members m
      join public.audiences x on x.id = m.audience_id
     where m.member_id = a and m.status = 'active' and x.kind = 'conversation'
  )
  select a <> b and not kw.is_blocked(a, b) and exists (
    select 1 from mine join public.audiences x on x.id = mine.id
     where x.owner_id = b
        or exists (select 1 from public.audience_members m
                    where m.audience_id = mine.id and m.member_id = b and m.status = 'active')
  )
$$;

create function kw.may_signal(target uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select target is not null and u is not null and target <> u and kw.is_active(u)
     and (kw.is_friend(u, target) or kw.shares_conversation(u, target))
$$;

create policy "kw inbox: owner receives" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and kw.inbox_owner((select realtime.topic())) = (select auth.uid())
  );

create policy "kw inbox: friends and co-members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and kw.may_signal(kw.inbox_owner((select realtime.topic())))
  );

-- Execute rights (new functions default to PUBLIC; match the rest of the schema).
revoke execute on function kw.conversation_members_changed(), kw.conversation_rekeyed(), kw.conversations_guard(),
  kw.inbox_owner(text), kw.shares_conversation(uuid, uuid), kw.may_signal(uuid, uuid) from public, anon;
grant execute on function kw.inbox_owner(text), kw.shares_conversation(uuid, uuid), kw.may_signal(uuid, uuid)
  to authenticated, service_role;
revoke execute on function public.leave_conversation(uuid) from public, anon;
grant execute on function public.leave_conversation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 5. Conversation list previews: the newest message of each conversation (RLS applies).
-- ---------------------------------------------------------------------------------------
create function public.conversation_previews(conv_ids uuid[]) returns setof public.messages
language sql stable security invoker set search_path = '' as $$
  select distinct on (m.conversation_id) m.*
    from public.messages m
   where m.conversation_id = any (conv_ids[1:100])
   order by m.conversation_id, m.created_at desc
$$;
revoke execute on function public.conversation_previews(uuid[]) from public, anon;
grant execute on function public.conversation_previews(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 6. Owners can always see their own audiences. kw.can_see_audience() looks the row up in a
--    STABLE function, which can't see a row inserted by the same statement, so
--    `insert … returning` (keyring.createAudience) failed RLS. A direct column check fixes it.
-- ---------------------------------------------------------------------------------------
create policy "owner sees own audiences" on public.audiences
  for select to authenticated using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- 7. pending_key_deliveries() runs as the caller, and audience_keys rows are only visible to
--    their recipient and sealer, so a conversation member couldn't see that another member had
--    already delivered a key — and retried (409) forever. Check delivery with a definer helper
--    that only answers yes/no for audiences the caller belongs to.
-- ---------------------------------------------------------------------------------------
create function kw.key_delivered(aud uuid, ep int, recipient uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.is_member(aud) and exists (
    select 1 from public.audience_keys k where k.audience_id = aud and k.epoch = ep and k.recipient_id = recipient)
$$;
revoke execute on function kw.key_delivered(uuid, int, uuid) from public, anon;
grant execute on function kw.key_delivered(uuid, int, uuid) to authenticated, service_role;

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
    and not kw.key_delivered(e.audience_id, e.epoch, e.recipient_id)
$$;
