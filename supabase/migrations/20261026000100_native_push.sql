-- Kithwall 2 phase 5: native push for the Android and iOS apps (docs/v2/05-native.md §5).
--
-- A native device registers a provider address (an FCM registration token, an APNs device token, or a
-- UnifiedPush endpoint URL) together with a P-256 public key and a 16-byte auth secret that the app made
-- on the device. The dispatch route encrypts the same "who + what" text it sends to browsers to that key
-- (RFC 8291 aes128gcm), so Google, Apple or the UnifiedPush distributor only ever carry ciphertext; the
-- app decrypts on the device and shows the notification (or a generic one for hidden chats).
--
-- The token is routing data, like a Web Push endpoint. UnifiedPush endpoints are arbitrary https URLs
-- chosen by the person's distributor: the dispatch route re-validates them and refuses non-public
-- addresses at connect time (SSRF), see apps/web/src/lib/push/endpoint.ts.

create table public.native_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('fcm', 'apns', 'unifiedpush')),
  token text not null unique check (
    char_length(token) <= 1024 and (
      (provider = 'fcm' and char_length(token) >= 32 and token ~ '^[A-Za-z0-9_:-]+$')
      or (provider = 'apns' and char_length(token) between 64 and 200 and token ~ '^[0-9a-f]+$')
      or (provider = 'unifiedpush' and token ~ '^https://[A-Za-z0-9.-]+(:443)?/[^[:space:]]*$' and strpos(token, chr(92)) = 0))),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),   -- 65-byte P-256 point
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$'),       -- 16-byte auth secret
  -- APNs only: which gateway issued the token (development builds use the sandbox).
  apns_env text check (apns_env is null or (apns_env in ('production', 'sandbox') and provider = 'apns')),
  -- A coarse label made on the device ("Kithwall app on Android"); never a raw user agent or a model.
  label text check (char_length(label) <= 60),
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index native_push_devices_user on public.native_push_devices (user_id);
alter table public.native_push_devices enable row level security;

-- Owners can see and remove their devices (Safety centre → Devices). Inserts and updates go through
-- register_native_push(), which validates and rate-limits.
create policy "owner reads native push devices" on public.native_push_devices for select to authenticated
  using (user_id = auth.uid());
create policy "owner removes native push devices" on public.native_push_devices for delete to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.native_push_devices');

-- Register (or take over) this app install's push address. Like browser subscriptions, a token moves to
-- whoever signs in on that device (holding it is proof of being on the device). At most 20 per person,
-- counting browser subscriptions separately.
create function public.register_native_push(
  p_provider text, p_token text, p_p256dh text, p_auth text, p_label text default null, p_apns_env text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); did uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not kw.is_active() or not kw.mfa_ok() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform kw.rate_limit('push_subscribe', 50, interval '1 day');
  insert into public.native_push_devices as d (user_id, provider, token, p256dh, auth, apns_env, label)
  values (uid, p_provider, p_token, p_p256dh, p_auth,
          case when p_provider = 'apns' then coalesce(p_apns_env, 'production') end,
          left(nullif(trim(p_label), ''), 60))
  on conflict (token) do update
    set user_id = excluded.user_id, provider = excluded.provider, p256dh = excluded.p256dh, auth = excluded.auth,
        apns_env = excluded.apns_env, label = excluded.label, created_at = now(), last_success_at = null
  returning d.id into did;
  delete from public.native_push_devices
   where user_id = uid and id not in (select id from public.native_push_devices where user_id = uid
                                      order by created_at desc limit 20);
  return did;
end $$;

-- Token rotation (FCM onNewToken, a new UnifiedPush endpoint) needs no extra route: the app re-registers
-- the new address with the person's session the next time it opens, and the provider answers
-- "unregistered" for the old one, which the dispatch route then deletes.

-- ---------------------------------------------------------------------------------------------
-- Dispatch: enqueue also when only a native device would receive it, and hand native devices to the
-- dispatch route. Same bodies as 20261020000100_push.sql plus the native rows.
-- ---------------------------------------------------------------------------------------------
create function kw.has_push_target(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_subscriptions s where s.user_id = u)
      or exists (select 1 from public.native_push_devices d where d.user_id = u)
$$;

create or replace function kw.push_enqueue() returns trigger
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
      wanted := kw.has_push_target(new.recipient_id);
    else
      wanted := exists (
        select 1 from public.conversations c
          join public.audiences a on a.id = c.audience_id
          cross join lateral (
            select a.owner_id as u
            union select m.member_id from public.audience_members m where m.audience_id = a.id and m.status = 'active') r
         where c.id = new.conversation_id and r.u <> new.sender_id and kw.has_push_target(r.u));
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

create or replace function public.push_plan(p_kind text, p_id uuid) returns jsonb
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
                   from public.push_subscriptions s where s.user_id = u.id),
        'native', (select jsonb_agg(jsonb_build_object('id', d.id, 'provider', d.provider, 'token', d.token,
                                                      'p256dh', d.p256dh, 'auth', d.auth, 'apns_env', d.apns_env))
                     from public.native_push_devices d where d.user_id = u.id)))
        from unnest(recipients) as u(id)
       where kw.has_push_target(u.id)), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------------
revoke execute on function kw.has_push_target(uuid), kw.push_enqueue() from public, anon, authenticated;
revoke execute on function public.push_plan(text, uuid) from public, anon, authenticated;
grant execute on function public.push_plan(text, uuid) to service_role;
revoke execute on function public.register_native_push(text, text, text, text, text, text) from public, anon;
grant execute on function public.register_native_push(text, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Data map (docs/v2/03-transparency.md): every new column is classified.
-- ---------------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.native_push_devices', 'account', 't.user_id = $1', 'created_at', null,
   'Until you turn notifications off in the app, sign out there, or the provider reports the app gone',
   'Where to deliver notifications to the Kithwall app on your phone. Notifications are encrypted to a key made on the phone, so Google, Apple or your UnifiedPush server only see ciphertext.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.native_push_devices', 'id', 'id', null),
  ('public.native_push_devices', 'user_id', 'id', null),
  ('public.native_push_devices', 'provider', 'plaintext', 'Google (FCM), Apple (APNs) or UnifiedPush'),
  ('public.native_push_devices', 'token', 'plaintext', 'push address at that provider'),
  ('public.native_push_devices', 'p256dh', 'plaintext', 'public key the phone decrypts notifications with'),
  ('public.native_push_devices', 'auth', 'hashed', 'random push secret'),
  ('public.native_push_devices', 'apns_env', 'plaintext', 'Apple production or test gateway'),
  ('public.native_push_devices', 'label', 'plaintext', 'app and system name'),
  ('public.native_push_devices', 'created_at', 'time', null),
  ('public.native_push_devices', 'last_success_at', 'time', null);
