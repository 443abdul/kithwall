-- Kithwall 2 Messages, phase 2 (docs/v2/00-brief.md §3 "read receipts off", §4 Messages, Circles).
--
--  1. Private read markers. Until now "last read" lived in audience_members.last_read_at, which every
--     co-member can select: read receipts were effectively always on. Read markers move to an
--     owner-only table; co-members only learn them through conversation_receipts(), and only when
--     BOTH sides turned read receipts on (default off, reciprocal like most messengers).
--  2. Privacy switches that the server has to enforce (everything else stays in the encrypted vault):
--     read receipts and who may send connection requests.
--  3. Message reactions: one per person per message, the emoji encrypted under the conversation key.
--     A separate table, so reacting doesn't bump the conversation, mark it unread or send a push.
--  4. Circle chats: a conversation can use a circle's own audience (kind 'group'), so its members and
--     keys are exactly the circle's. Leaving the chat means leaving the circle (not via leave_conversation).

-- ---------------------------------------------------------------------------------------
-- 1. Read markers
-- ---------------------------------------------------------------------------------------
create table public.conversation_reads (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_reads_user on public.conversation_reads (user_id);
alter table public.conversation_reads enable row level security;

create policy "owner reads own read markers" on public.conversation_reads for select to authenticated
  using (user_id = auth.uid());
create policy "member sets own read marker" on public.conversation_reads for insert to authenticated
  with check (user_id = auth.uid() and kw.is_member(kw.conversation_audience(conversation_id)));
create policy "member moves own read marker" on public.conversation_reads for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and kw.is_member(kw.conversation_audience(conversation_id)));
create policy "owner clears own read marker" on public.conversation_reads for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.conversation_reads');

-- Markers only move forward and never into the future.
create function kw.conversation_reads_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.last_read_at > now() then new.last_read_at := now(); end if;
  if tg_op = 'UPDATE' then
    if new.conversation_id <> old.conversation_id or new.user_id <> old.user_id then
      raise exception 'read marker identity is immutable';
    end if;
    new.last_read_at := greatest(old.last_read_at, new.last_read_at);
  end if;
  return new;
end $$;
create trigger conversation_reads_guard before insert or update on public.conversation_reads
  for each row execute function kw.conversation_reads_guard();

-- Carry existing markers over, then stop keeping them where co-members can see them.
insert into public.conversation_reads (conversation_id, user_id, last_read_at)
  select c.id, am.member_id, least(am.last_read_at, now())
    from public.audience_members am
    join public.conversations c on c.audience_id = am.audience_id
   where am.last_read_at is not null
  on conflict do nothing;

update public.audience_members am set last_read_at = null
  from public.audiences a
 where a.id = am.audience_id and a.kind = 'conversation' and am.last_read_at is not null;

create function kw.conversation_member_no_read_marker() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.last_read_at is not null and kw.audience_kind(new.audience_id) = 'conversation' then
    new.last_read_at := null;   -- older clients: their marker is simply not stored here any more
  end if;
  return new;
end $$;
create trigger conversation_member_no_read_marker before insert or update of last_read_at on public.audience_members
  for each row execute function kw.conversation_member_no_read_marker();

-- ---------------------------------------------------------------------------------------
-- 2. Server-enforced privacy switches (no row = defaults: receipts off, requests from everyone)
-- ---------------------------------------------------------------------------------------
create table public.privacy_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  read_receipts boolean not null default false,
  requests_from text not null default 'everyone' check (requests_from in ('everyone', 'mutual', 'nobody')),
  updated_at timestamptz not null default now()
);
alter table public.privacy_prefs enable row level security;
create policy "owner reads privacy prefs" on public.privacy_prefs for select to authenticated
  using (user_id = auth.uid());
create policy "owner sets privacy prefs" on public.privacy_prefs for insert to authenticated
  with check (user_id = auth.uid());
create policy "owner changes privacy prefs" on public.privacy_prefs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner clears privacy prefs" on public.privacy_prefs for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.privacy_prefs');

create function kw.privacy_prefs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger privacy_prefs_guard before insert or update on public.privacy_prefs
  for each row execute function kw.privacy_prefs_guard();

create function kw.read_receipts_on(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.read_receipts from public.privacy_prefs p where p.user_id = u), false)
$$;

-- May `sender` ask `target` to connect? 'mutual' = they share a connection or a circle.
create function kw.may_request(sender uuid, target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case coalesce((select p.requests_from from public.privacy_prefs p where p.user_id = target), 'everyone')
    when 'everyone' then true
    when 'nobody' then false
    else exists (
        select 1 from public.friendships f1
          join public.friendships f2
            on f2.status = 'accepted'
           and (case when f1.user_a = sender then f1.user_b else f1.user_a end) in (f2.user_a, f2.user_b)
           and target in (f2.user_a, f2.user_b)
         where f1.status = 'accepted' and sender in (f1.user_a, f1.user_b)
           and (case when f1.user_a = sender then f1.user_b else f1.user_a end) <> target)
      or exists (
        select 1 from public.audience_members a
          join public.audience_members b on b.audience_id = a.audience_id
          join public.audiences x on x.id = a.audience_id and x.kind = 'group'
         where a.member_id = sender and a.status = 'active' and b.member_id = target and b.status = 'active')
      or exists (
        select 1 from public.audiences x
          join public.audience_members m on m.audience_id = x.id and m.status = 'active'
         where x.kind = 'group'
           and ((x.owner_id = sender and m.member_id = target) or (x.owner_id = target and m.member_id = sender)))
  end
$$;

-- Restrictive: applies on top of the existing "request friendship" policy. Invite links redeem
-- through redeem_invite() (definer), so a shared invite always works.
create policy "recipient accepts requests from" on public.friendships as restrictive for insert to authenticated
  with check (kw.may_request(auth.uid(), case when user_a = auth.uid() then user_b else user_a end));

-- Read receipts for a conversation: the other members who share theirs, only if I share mine.
create function public.conversation_receipts(conv uuid)
returns table (user_id uuid, last_read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.user_id, r.last_read_at
    from public.conversation_reads r
   where r.conversation_id = conv
     and r.user_id <> auth.uid()
     and auth.uid() is not null
     and kw.is_member(kw.conversation_audience(conv))
     and kw.is_member(kw.conversation_audience(conv), r.user_id)
     and kw.read_receipts_on(auth.uid())
     and kw.read_receipts_on(r.user_id)
$$;

-- Unread badge for pushes: conversations (owned or joined, including circle chats) with a message
-- from someone else newer than my private read marker.
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
                       and m.created_at > coalesce((select r.last_read_at from public.conversation_reads r
                                                     where r.conversation_id = c.id and r.user_id = u), '-infinity'::timestamptz))))::int
$$;

-- ---------------------------------------------------------------------------------------
-- 3. Reactions. `enc` = encryptBlob(conversation key @ epoch, emoji, "message-reaction/<msg>/<user>/<epoch>");
--    null = reaction removed (kept as an UPDATE so Realtime can filter it by conversation).
-- ---------------------------------------------------------------------------------------
create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  enc text check (enc is null or char_length(enc) <= 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_reactions_conversation on public.message_reactions (conversation_id, message_id);
alter table public.message_reactions enable row level security;

create policy "members see reactions" on public.message_reactions for select to authenticated
  using (kw.is_member(kw.conversation_audience(conversation_id)));
create policy "members react" on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and kw.is_active()
              and kw.is_member(kw.conversation_audience(conversation_id))
              and not kw.dm_blocked(conversation_id));
create policy "members change own reaction" on public.message_reactions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and kw.is_member(kw.conversation_audience(conversation_id)));
create policy "members remove own reaction" on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.message_reactions');

create function kw.message_reactions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.message_id <> old.message_id or new.user_id <> old.user_id or new.conversation_id <> old.conversation_id then
      raise exception 'reaction identity is immutable';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  -- The reaction must belong to the message's own conversation.
  if not exists (select 1 from public.messages m where m.id = new.message_id and m.conversation_id = new.conversation_id) then
    raise exception 'reaction does not match its message' using errcode = '22023';
  end if;
  perform kw.rate_limit('reaction', 3000, interval '1 day');
  new.updated_at := now();
  return new;
end $$;
create trigger message_reactions_guard before insert or update on public.message_reactions
  for each row execute function kw.message_reactions_guard();

alter publication supabase_realtime add table public.message_reactions;

-- ---------------------------------------------------------------------------------------
-- 4. Circle chats: one conversation per circle, on the circle's own audience.
--    (conversations.audience_id is already unique, so there can only ever be one.)
-- ---------------------------------------------------------------------------------------
create policy "circle members start the circle chat" on public.conversations for insert to authenticated
  with check (created_by = auth.uid() and kw.is_active()
              and dm_key is null
              and kw.audience_kind(audience_id) = 'group'
              and kw.is_member(audience_id));

create or replace function public.leave_conversation(conv uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  a record;
  succ uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select x.id, x.owner_id, x.kind, c.dm_key into a
    from public.conversations c join public.audiences x on x.id = c.audience_id
   where c.id = conv
   for update of x;
  if not found or not kw.is_member(a.id, uid) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if a.kind <> 'conversation' then
    raise exception 'circle chats are left by leaving the circle' using errcode = '22023';
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
      delete from public.audiences where id = a.id;
      return;
    end if;
    update public.audience_members set role = 'admin' where audience_id = a.id and member_id = succ;
    update public.audiences set owner_id = succ where id = a.id;
  end if;
  delete from public.audience_members where audience_id = a.id and member_id = uid;
end $$;

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.conversation_reads_guard(), kw.conversation_member_no_read_marker(),
  kw.privacy_prefs_guard(), kw.message_reactions_guard() from public, anon, authenticated;
revoke execute on function kw.read_receipts_on(uuid), kw.may_request(uuid, uuid) from public, anon;
grant execute on function kw.read_receipts_on(uuid), kw.may_request(uuid, uuid) to authenticated, service_role;
revoke execute on function kw.push_badge(uuid) from public, anon, authenticated;
revoke execute on function public.conversation_receipts(uuid), public.leave_conversation(uuid) from public, anon;
grant execute on function public.conversation_receipts(uuid), public.leave_conversation(uuid) to authenticated, service_role;
