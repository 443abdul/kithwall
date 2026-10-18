-- Web Push (spec §12 "Push notifications"). Browsers register a push subscription (an endpoint at
-- their vendor's push service plus the keys used to encrypt payloads, RFC 8291). When a notification
-- or message row is inserted, an AFTER INSERT trigger asks pg_net to POST *only the row id* to our
-- dispatch route (Vercel), which looks the row up with the secret key and sends a "who + what" push
-- ("dan sent you a message"). The server never had message or post content to put in it.
--
-- Nothing here can block or fail the insert that triggered it: the trigger body is wrapped in an
-- exception handler and does nothing when kw.push_config is empty (local dev, previews, tests).

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------------------
-- 1. Subscriptions (one per browser/device). Owner-only. The endpoint is a capability URL at the
--    browser vendor's push service; it is restricted to the known push services so the dispatch
--    route can never be pointed at an arbitrary host (SSRF).
--    `user_agent` holds a coarse label made on the device ("Chrome on Android"), never the raw
--    User-Agent string (spec §7: no user agents in app tables).
-- ---------------------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (
    char_length(endpoint) <= 1024
    and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)/'),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),   -- 65-byte P-256 point
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$'),       -- 16-byte auth secret
  user_agent text check (char_length(user_agent) <= 60),
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;

create policy "owner reads push subscriptions" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "owner adds push subscriptions" on public.push_subscriptions for insert to authenticated
  with check (user_id = auth.uid() and kw.is_active());
create policy "owner updates push subscriptions" on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner removes push subscriptions" on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.push_subscriptions');

create function kw.push_subscriptions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- (Owners can't hand a row to someone else: the update policy's WITH CHECK pins user_id.)
  new.created_at := now();
  new.last_success_at := null;
  return new;
end $$;
create trigger push_subscriptions_guard before insert on public.push_subscriptions
  for each row execute function kw.push_subscriptions_guard();

-- Register (or take over) this browser's subscription. A browser has exactly one endpoint; when a
-- different person signs in on the same device, the endpoint moves to them (holding the endpoint is
-- proof of being on that device). Keeps at most 20 devices per person.
create function public.register_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_label text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not kw.is_active() or not kw.mfa_ok() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform kw.rate_limit('push_subscribe', 50, interval '1 day');
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, user_agent)
  values (uid, p_endpoint, p_p256dh, p_auth, left(nullif(trim(p_label), ''), 60))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, created_at = now(), last_success_at = null
  returning s.id into sid;
  delete from public.push_subscriptions
   where user_id = uid and id not in (select id from public.push_subscriptions where user_id = uid
                                      order by created_at desc limit 20);
  return sid;
end $$;

-- ---------------------------------------------------------------------------------------
-- 2. Per-person push preferences (which kinds of activity to push). Not content: just switches.
--    No row = everything on.
-- ---------------------------------------------------------------------------------------
create table public.push_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  messages boolean not null default true,
  activity boolean not null default true,          -- comments, likes, tags, wall posts, mentions
  friend_requests boolean not null default true,
  pokes boolean not null default true,
  invites boolean not null default true,           -- group / event invites, join requests, games
  security boolean not null default true,          -- recovery requests, key-sharing requests
  updated_at timestamptz not null default now()
);
alter table public.push_preferences enable row level security;
create policy "owner reads push preferences" on public.push_preferences for select to authenticated
  using (user_id = auth.uid());
create policy "owner sets push preferences" on public.push_preferences for insert to authenticated
  with check (user_id = auth.uid());
create policy "owner changes push preferences" on public.push_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner clears push preferences" on public.push_preferences for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.push_preferences');

-- ---------------------------------------------------------------------------------------
-- 3. Private dispatch configuration (single row). Lives in `kw`, which the Data API does not expose,
--    and is readable only by the database owner (the trigger runs as its definer).
--      insert into kw.push_config (dispatch_url, secret)
--      values ('https://www.kithwall.com/api/push/dispatch', '<PUSH_DISPATCH_SECRET>')
--      on conflict (id) do update set dispatch_url = excluded.dispatch_url, secret = excluded.secret, updated_at = now();
-- ---------------------------------------------------------------------------------------
create table kw.push_config (
  id boolean primary key default true check (id),
  dispatch_url text not null check (dispatch_url ~ '^https?://[^\s]+$'),
  secret text not null check (char_length(secret) >= 32),
  updated_at timestamptz not null default now()
);
alter table kw.push_config enable row level security;   -- no policies: nobody but the owner
revoke all on table kw.push_config from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 4. Triggers: enqueue {kind, id} to the dispatch route. Only when someone who would receive it
--    has a push subscription, so ordinary traffic doesn't call out at all.
-- ---------------------------------------------------------------------------------------
create function kw.push_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cfg record;
  kind text := tg_argv[0];
  wanted boolean;
begin
  begin
    select c.dispatch_url, c.secret into cfg from kw.push_config c where c.id;
    if not found then return null; end if;
    if kind = 'notification' then
      wanted := exists (select 1 from public.push_subscriptions s where s.user_id = new.recipient_id);
    else
      wanted := exists (
        select 1 from public.conversations c
          join public.audiences a on a.id = c.audience_id
          join public.push_subscriptions s
            on s.user_id = a.owner_id
            or s.user_id in (select m.member_id from public.audience_members m
                              where m.audience_id = a.id and m.status = 'active')
         where c.id = new.conversation_id and s.user_id <> new.sender_id);
    end if;
    if wanted then
      perform net.http_post(
        url := cfg.dispatch_url,
        body := jsonb_build_object('kind', kind, 'id', new.id),
        params := '{}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-kw-push-secret', cfg.secret),
        timeout_milliseconds := 10000);
    end if;
  exception when others then
    raise warning 'kithwall push: not queued (%)', sqlstate;
  end;
  return null;
end $$;

create trigger push_on_notification after insert on public.notifications
  for each row execute function kw.push_enqueue('notification');
create trigger push_on_message after insert on public.messages
  for each row execute function kw.push_enqueue('message');

-- ---------------------------------------------------------------------------------------
-- 5. Server-only (secret key): everything the dispatch route needs, in one round trip.
--    Returns null when the row is gone. Recipients: the notification's recipient, or every active
--    member (and the owner) of the conversation except the sender, skipping blocks.
-- ---------------------------------------------------------------------------------------
create function kw.push_badge(u uuid) returns int
language sql stable security definer set search_path = '' as $$
  select least(999,
    (select count(*) from public.notifications n where n.recipient_id = u and n.read_at is null)
  + (select count(*) from public.audience_members am
       join public.conversations c on c.audience_id = am.audience_id
      where am.member_id = u and am.status = 'active'
        and c.last_message_at > coalesce(am.last_read_at, '-infinity'::timestamptz)
        and exists (select 1 from public.messages m
                     where m.conversation_id = c.id and m.sender_id <> u
                       and m.created_at > coalesce(am.last_read_at, '-infinity'::timestamptz))))::int
$$;

create function public.push_plan(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid; ntype text; okind text; oid uuid; conv uuid; aud uuid; is_group boolean := false;
  created timestamptz; recipients uuid[];
  prof record;
begin
  if p_kind = 'notification' then
    select n.actor_id, n.type, n.object_kind, n.object_id, n.created_at, array[n.recipient_id]
      into actor, ntype, okind, oid, created, recipients
      from public.notifications n where n.id = p_id;
    if not found then return null; end if;
  elsif p_kind = 'message' then
    select m.sender_id, m.conversation_id, m.created_at, c.audience_id, c.dm_key is null
      into actor, conv, created, aud, is_group
      from public.messages m join public.conversations c on c.id = m.conversation_id where m.id = p_id;
    if not found then return null; end if;
    select coalesce(array_agg(distinct u), '{}') into recipients from (
      select m.member_id as u from public.audience_members m where m.audience_id = aud and m.status = 'active'
      union select a.owner_id from public.audiences a where a.id = aud) r
     where r.u <> actor and not kw.is_blocked(actor, r.u);
  else
    return null;
  end if;

  select p.username::text as username, case when p.discoverable then p.display_name_public end as display
    into prof from public.profiles p where p.id = actor;

  return jsonb_build_object(
    'kind', p_kind, 'type', ntype, 'object_kind', okind, 'object_id', oid,
    'conversation_id', conv, 'group', is_group, 'created_at', created,
    'actor', jsonb_build_object('username', prof.username, 'display', prof.display),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', u.id,
        'badge', kw.push_badge(u.id),
        'prefs', (select to_jsonb(pp) - 'user_id' - 'updated_at' from public.push_preferences pp where pp.user_id = u.id),
        'subs', (select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
                   from public.push_subscriptions s where s.user_id = u.id)))
        from unnest(recipients) as u(id)
       where exists (select 1 from public.push_subscriptions s where s.user_id = u.id)), '[]'::jsonb));
end $$;

-- Signed-in users: rate limit for "Send a test notification" (called with the user's JWT).
create function public.push_test_allowed() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform kw.rate_limit('push_test', 10, interval '1 hour');
end $$;

-- ---------------------------------------------------------------------------------------
-- 6. Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.push_enqueue(), kw.push_subscriptions_guard(), kw.push_badge(uuid)
  from public, anon, authenticated;
revoke execute on function public.push_plan(text, uuid) from public, anon, authenticated;
grant execute on function public.push_plan(text, uuid) to service_role;
revoke execute on function public.register_push_subscription(text, text, text, text), public.push_test_allowed()
  from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text), public.push_test_allowed()
  to authenticated, service_role;
