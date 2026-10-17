-- Messaging, notifications, pokes, invites, trusted-friend recovery, reports, moderation,
-- feed RPC, storage bucket and realtime.

-- Conversations & messages ----------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  audience_id uuid not null unique references public.audiences (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  dm_key text unique,                      -- "<smaller uuid>:<larger uuid>" for one-to-one chats
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index conversations_recent on public.conversations (last_message_at desc);
alter table public.conversations enable row level security;

create policy "members see conversation" on public.conversations for select to authenticated
  using (kw.is_member(audience_id));
create policy "start a conversation" on public.conversations for insert to authenticated
  with check (created_by = auth.uid() and kw.is_active()
              and kw.audience_owner(audience_id) = auth.uid()
              and kw.audience_kind(audience_id) = 'conversation'
              and (dm_key is null or auth.uid()::text = any (string_to_array(dm_key, ':'))));

create table public.messages (
  id uuid primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  envelope jsonb not null check (octet_length(envelope::text) < 65536),
  created_at timestamptz not null default now()
);
create index messages_conversation on public.messages (conversation_id, created_at desc);
alter table public.messages enable row level security;
alter table public.media_objects
  add constraint media_objects_message_fk foreign key (message_id) references public.messages (id) on delete cascade;

create function kw.conversation_audience(conv uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select audience_id from public.conversations where id = conv
$$;

create function kw.dm_blocked(conv uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.conversations c where c.id = conv and c.dm_key is not null
                 and kw.is_blocked(split_part(c.dm_key, ':', 1)::uuid, split_part(c.dm_key, ':', 2)::uuid))
$$;

create policy "members read messages" on public.messages for select to authenticated
  using (kw.is_member(kw.conversation_audience(conversation_id)));
create policy "members send messages" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and kw.is_active()
              and kw.is_member(kw.conversation_audience(conversation_id))
              and not kw.dm_blocked(conversation_id));
create policy "sender deletes own message" on public.messages for delete to authenticated
  using (sender_id = auth.uid());

create function kw.messages_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('message', 2000, interval '1 day');
  new.created_at := now();
  update public.conversations set last_message_at = now() where id = new.conversation_id;
  return new;
end $$;
create trigger messages_guard before insert on public.messages
  for each row execute function kw.messages_guard();

-- Notifications ----------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in (
    'friend_request', 'friend_accept', 'wall_post', 'comment', 'like', 'tag', 'poke',
    'group_invite', 'group_request', 'event_invite', 'mention', 'share', 'question_vote',
    'checkin_tag', 'relationship', 'recovery_request', 'recovery_trustee', 'game', 'key_waiting')),
  object_kind text check (object_kind in ('post', 'comment', 'photo', 'group', 'event', 'conversation',
                                          'profile', 'recovery_request', 'page')),
  object_id uuid,
  sealed jsonb check (sealed is null or octet_length(sealed::text) < 2048),   -- preview sealed to recipient
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_recipient on public.notifications (recipient_id, created_at desc);
alter table public.notifications enable row level security;

create function kw.shares_audience(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audience_members m1
                 join public.audience_members m2 on m2.audience_id = m1.audience_id
                 where m1.member_id = a and m2.member_id = b and m1.status = 'active' and m2.status in ('active', 'invited', 'requested'))
      or exists (select 1 from public.audiences x join public.audience_members m on m.audience_id = x.id
                 where x.kind in ('group', 'event', 'conversation')
                   and ((x.owner_id = a and m.member_id = b) or (x.owner_id = b and m.member_id = a)))
$$;

create policy "recipient reads notifications" on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy "notify people you are connected to" on public.notifications for insert to authenticated
  with check (
    actor_id = auth.uid() and recipient_id <> auth.uid() and kw.is_active()
    and not kw.is_blocked(actor_id, recipient_id)
    and (kw.is_friend(actor_id, recipient_id)
         or kw.shares_audience(actor_id, recipient_id)
         or (type = 'friend_request' and exists (select 1 from public.friendships f
              where f.user_a = least(actor_id, recipient_id) and f.user_b = greatest(actor_id, recipient_id)
                and f.requested_by = auth.uid() and f.status = 'pending')))
  );
create policy "recipient marks read" on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
create policy "recipient deletes" on public.notifications for delete to authenticated
  using (recipient_id = auth.uid());

create function kw.notifications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('notification', 3000, interval '1 day');
    new.created_at := now(); new.read_at := null;
    return new;
  end if;
  if new.recipient_id <> old.recipient_id or new.actor_id <> old.actor_id or new.type <> old.type
     or new.sealed is distinct from old.sealed or new.object_id is distinct from old.object_id then
    raise exception 'only read state can change';
  end if;
  return new;
end $$;
create trigger notifications_guard before insert or update on public.notifications
  for each row execute function kw.notifications_guard();

-- Pokes ---------------------------------------------------------------------------------
create table public.pokes (
  from_id uuid not null references public.profiles (id) on delete cascade,
  to_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index pokes_to on public.pokes (to_id);
alter table public.pokes enable row level security;
create policy "parties see pokes" on public.pokes for select to authenticated
  using (auth.uid() in (from_id, to_id));
create policy "poke friends (once until poked back)" on public.pokes for insert to authenticated
  with check (from_id = auth.uid() and kw.is_friend(from_id, to_id) and kw.is_active());
create policy "remove pokes you sent or received" on public.pokes for delete to authenticated
  using (auth.uid() in (from_id, to_id));
create function kw.pokes_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('poke', 200, interval '1 day');
  delete from public.pokes where from_id = new.to_id and to_id = new.from_id;  -- poking back clears theirs
  new.created_at := now();
  return new;
end $$;
create trigger pokes_guard before insert on public.pokes
  for each row execute function kw.pokes_guard();

-- Invites ----------------------------------------------------------------------------------
create table public.invites (
  code text primary key default encode(extensions.gen_random_bytes(12), 'hex'),
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  max_uses int not null default 10 check (max_uses between 1 and 100),
  uses int not null default 0,
  expires_at timestamptz not null default now() + interval '30 days',
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security;
create policy "inviter manages invites" on public.invites for all to authenticated
  using (inviter_id = auth.uid()) with check (inviter_id = auth.uid() and uses = 0);

-- Redeem an invite after sign-up: sends a friend request from the new user to the inviter.
create function public.redeem_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv record; me uuid := auth.uid();
begin
  select * into inv from public.invites where code = invite_code for update;
  if not found or inv.expires_at < now() or inv.uses >= inv.max_uses then
    raise exception 'invite is invalid or expired';
  end if;
  if inv.inviter_id = me then return inv.inviter_id; end if;
  update public.invites set uses = uses + 1 where code = invite_code;
  insert into public.friendships (user_a, user_b, requested_by)
    values (least(me, inv.inviter_id), greatest(me, inv.inviter_id), me)
    on conflict do nothing;
  return inv.inviter_id;
end $$;

-- Trusted-friend recovery (spec §3.5) ---------------------------------------------------
create table public.recovery_shares (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  trustee_id uuid not null references public.profiles (id) on delete cascade,
  setup_id uuid not null,
  threshold int not null check (threshold between 2 and 5),
  sealed jsonb not null check (octet_length(sealed::text) < 2048),
  created_at timestamptz not null default now(),
  primary key (owner_id, trustee_id),
  check (owner_id <> trustee_id)
);
alter table public.recovery_shares enable row level security;
create policy "owner and trustee see share" on public.recovery_shares for select to authenticated
  using (auth.uid() in (owner_id, trustee_id));
create policy "owner assigns friends as trustees" on public.recovery_shares for insert to authenticated
  with check (owner_id = auth.uid() and kw.is_friend(owner_id, trustee_id));
create policy "owner removes trustees" on public.recovery_shares for delete to authenticated
  using (owner_id = auth.uid());

create table public.recovery_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  eph_pub text not null check (char_length(eph_pub) = 43),
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  not_before timestamptz not null default now() + interval '24 hours',
  expires_at timestamptz not null default now() + interval '72 hours',
  created_at timestamptz not null default now()
);
alter table public.recovery_requests enable row level security;
create policy "owner and trustees see requests" on public.recovery_requests for select to authenticated
  using (owner_id = auth.uid() or exists (select 1 from public.recovery_shares s
         where s.owner_id = recovery_requests.owner_id and s.trustee_id = auth.uid()));
create policy "owner starts recovery" on public.recovery_requests for insert to authenticated
  with check (owner_id = auth.uid() and status = 'pending');
create policy "owner cancels or completes" on public.recovery_requests for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create function kw.recovery_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('recovery_request', 3, interval '1 day');
    new.created_at := now();
    -- Waiting period comes from settings (default 24 h); never shorter than server policy.
    new.not_before := now() + coalesce((kw.setting('recovery_wait_hours')::text)::int, 24) * interval '1 hour';
    new.expires_at := now() + interval '72 hours';
    new.status := 'pending';
    return new;
  end if;
  if new.not_before <> old.not_before or new.expires_at <> old.expires_at or new.eph_pub <> old.eph_pub
     or new.owner_id <> old.owner_id then
    raise exception 'recovery request is immutable';
  end if;
  if old.status <> 'pending' then raise exception 'recovery request is closed'; end if;
  return new;
end $$;
create trigger recovery_requests_guard before insert or update on public.recovery_requests
  for each row execute function kw.recovery_requests_guard();

create table public.recovery_responses (
  request_id uuid not null references public.recovery_requests (id) on delete cascade,
  trustee_id uuid not null references public.profiles (id) on delete cascade,
  sealed jsonb not null check (octet_length(sealed::text) < 2048),
  created_at timestamptz not null default now(),
  primary key (request_id, trustee_id)
);
alter table public.recovery_responses enable row level security;
create policy "owner and responding trustee see responses" on public.recovery_responses for select to authenticated
  using (trustee_id = auth.uid() or exists (select 1 from public.recovery_requests r
         where r.id = request_id and r.owner_id = auth.uid()));
create policy "trustee responds after waiting period" on public.recovery_responses for insert to authenticated
  with check (trustee_id = auth.uid() and exists (
    select 1 from public.recovery_requests r
    join public.recovery_shares s on s.owner_id = r.owner_id and s.trustee_id = auth.uid()
    where r.id = request_id and r.status = 'pending' and now() >= r.not_before and now() < r.expires_at));

-- Reports & moderation -------------------------------------------------------------------
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_kind text not null check (target_kind in ('post', 'comment', 'photo', 'message', 'profile', 'group', 'event', 'page')),
  target_id uuid not null,
  target_owner_id uuid references public.profiles (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'violence', 'nudity', 'child_safety',
                                         'self_harm', 'impersonation', 'illegal', 'other')),
  details text check (char_length(details) <= 2000),
  disclosed jsonb check (disclosed is null or octet_length(disclosed::text) < 131072), -- plaintext + content key
  stored_envelope jsonb,                                                                 -- server copy, for verification
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  moderator_id uuid references public.profiles (id) on delete set null,
  decision_note text check (char_length(decision_note) <= 4000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index reports_open on public.reports (status, created_at);
alter table public.reports enable row level security;
create policy "reporter and staff see reports" on public.reports for select to authenticated
  using (reporter_id = auth.uid() or kw.is_staff());
create policy "report items you can see" on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and status = 'open' and moderator_id is null);
create policy "staff resolve reports" on public.reports for update to authenticated
  using (kw.is_staff()) with check (kw.is_staff());

create function kw.reports_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('report', 50, interval '1 day');
    new.created_at := now();
    -- Snapshot the stored ciphertext so moderators can check the disclosed key decrypts it,
    -- and record whose content it is. Reporter must be able to see the target.
    if new.target_kind = 'post' then
      if not kw.can_read_post(new.target_id) then raise exception 'cannot report what you cannot see'; end if;
      select envelope, author_id into new.stored_envelope, new.target_owner_id from public.posts where id = new.target_id;
    elsif new.target_kind = 'comment' then
      if not kw.can_read_target('comment', new.target_id) then raise exception 'cannot report what you cannot see'; end if;
      select envelope, author_id into new.stored_envelope, new.target_owner_id from public.comments where id = new.target_id;
    elsif new.target_kind = 'photo' then
      if not kw.can_read_photo(new.target_id) then raise exception 'cannot report what you cannot see'; end if;
      select envelope, owner_id into new.stored_envelope, new.target_owner_id from public.photos where id = new.target_id;
    elsif new.target_kind = 'message' then
      if not exists (select 1 from public.messages x where x.id = new.target_id
                     and kw.is_member(kw.conversation_audience(x.conversation_id))) then
        raise exception 'cannot report what you cannot see';
      end if;
      select envelope, sender_id into new.stored_envelope, new.target_owner_id from public.messages where id = new.target_id;
    elsif new.target_kind = 'profile' then
      new.target_owner_id := new.target_id;
    end if;
    return new;
  end if;
  if new.status <> old.status and new.status <> 'open' then
    new.moderator_id := auth.uid(); new.resolved_at := now();
  end if;
  if new.reporter_id <> old.reporter_id or new.disclosed is distinct from old.disclosed
     or new.stored_envelope is distinct from old.stored_envelope or new.target_id <> old.target_id then
    raise exception 'report evidence is immutable';
  end if;
  return new;
end $$;
create trigger reports_guard before insert or update on public.reports
  for each row execute function kw.reports_guard();

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  moderator_id uuid not null references public.profiles (id) on delete set null,
  target_user_id uuid not null references public.profiles (id) on delete cascade,
  report_id uuid references public.reports (id) on delete set null,
  action text not null check (action in ('warn', 'remove_content', 'suspend', 'ban', 'restore')),
  reason text not null check (char_length(reason) between 1 and 2000),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.moderation_actions enable row level security;
create policy "staff and affected user see actions" on public.moderation_actions for select to authenticated
  using (kw.is_staff() or target_user_id = auth.uid());
create policy "staff record actions" on public.moderation_actions for insert to authenticated
  with check (kw.is_staff() and moderator_id = auth.uid());

create function kw.apply_moderation_action() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.action = 'suspend' then
    update public.profiles set status = 'suspended', suspended_until = coalesce(new.expires_at, now() + interval '7 days')
     where id = new.target_user_id;
  elsif new.action = 'ban' then
    if not kw.is_admin() then raise exception 'only admins can ban'; end if;
    update public.profiles set status = 'banned', suspended_until = null where id = new.target_user_id;
  elsif new.action = 'restore' then
    update public.profiles set status = 'active', suspended_until = null where id = new.target_user_id;
  end if;
  return new;
end $$;
create trigger apply_moderation_action after insert on public.moderation_actions
  for each row execute function kw.apply_moderation_action();

-- Feed RPC: newest readable posts from you, your friends, and groups/events you're in.
create function public.feed_posts(before timestamptz default 'infinity', page_size int default 20)
returns setof public.posts
language sql stable security invoker set search_path = '' as $$
  select p.* from public.posts p
  where p.created_at < before
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

-- Storage: one private bucket of ciphertext blobs. Paths are "<owner uuid>/<object uuid>[-size]".
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 31457280)
on conflict (id) do nothing;

create policy "upload into own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text and kw.is_active());
create policy "read media you're entitled to" on storage.objects for select to authenticated
  using (bucket_id = 'media' and kw.can_read_media(name));
create policy "delete own media" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- Realtime: changes on these tables are delivered to subscribers that pass RLS.
alter publication supabase_realtime add table
  public.messages, public.notifications, public.pokes, public.friendships, public.conversations,
  public.comments, public.likes, public.audience_keys;

-- Execute rights: helper functions are only for policies; RPCs for signed-in users.
revoke execute on all functions in schema kw from public, anon;
grant execute on all functions in schema kw to authenticated, service_role;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
