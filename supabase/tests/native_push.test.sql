-- Native push (docs/v2/05-native.md §5): device rows are owner-only and written through
-- register_native_push(), tokens are shape-checked per provider (UnifiedPush endpoints must be https),
-- the enqueue trigger fires for people who only have the app, and the dispatch plan hands native devices
-- to the server. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000006a1'), ('bob', '00000000-0000-0000-0000-0000000006b0'),
  ('carol', '00000000-0000-0000-0000-0000000006c0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-npush@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'npush', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'carol');

-- A DM between alice and bob.
insert into public.audiences (id, owner_id, kind) values ('60000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  select '60000000-0000-0000-0000-000000000001', id, case when name = 'alice' then 'admin' else 'member' end, 'active', pg_temp.uid('alice')
    from ids where name in ('alice', 'bob');
insert into public.conversations (id, audience_id, created_by, dm_key) values
  ('61000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', pg_temp.uid('alice'),
   least(pg_temp.uid('alice'), pg_temp.uid('bob'))::text || ':' || greatest(pg_temp.uid('alice'), pg_temp.uid('bob'))::text);

-- ---------------------------------------------------------------------------------------
-- Registering
-- ---------------------------------------------------------------------------------------
select pg_temp.login('bob');
select lives_ok($$ select public.register_native_push('fcm', 'fcmtoken-bob-' || repeat('x', 140), repeat('B', 87), repeat('a', 22), 'Kithwall app on Android') $$,
  'an FCM device registers');
select lives_ok($$ select public.register_native_push('unifiedpush', 'https://ntfy.example.org/upBob123?up=1', repeat('C', 87), repeat('b', 22), 'Kithwall app on Android (UnifiedPush)') $$,
  'a UnifiedPush device registers');
select lives_ok($$ select public.register_native_push('apns', repeat('ab', 32), repeat('D', 87), repeat('c', 22), 'Kithwall app on iOS', 'sandbox') $$,
  'an APNs device registers');
select is((select count(*)::int from public.native_push_devices), 3, 'the owner sees their devices');
select is((select apns_env from public.native_push_devices where provider = 'apns'), 'sandbox', 'APNs gateway recorded');
select is((select apns_env from public.native_push_devices where provider = 'fcm'), null, 'no APNs gateway for other providers');

select throws_ok($$ select public.register_native_push('unifiedpush', 'http://ntfy.example.org/x', repeat('C', 87), repeat('b', 22)) $$,
  '23514', null, 'UnifiedPush endpoints must be https');
select throws_ok($$ select public.register_native_push('unifiedpush', 'https://ntfy.example.org:8080/x', repeat('C', 87), repeat('b', 22)) $$,
  '23514', null, 'UnifiedPush endpoints use the default port');
select throws_ok($$ select public.register_native_push('unifiedpush', 'https://user@ntfy.example.org/x', repeat('C', 87), repeat('b', 22)) $$,
  '23514', null, 'UnifiedPush endpoints carry no credentials');
select throws_ok($$ select public.register_native_push('apns', 'not-hex', repeat('D', 87), repeat('c', 22)) $$,
  '23514', null, 'APNs tokens are hex');
select throws_ok($$ select public.register_native_push('fcm', 'short', repeat('D', 87), repeat('c', 22)) $$,
  '23514', null, 'FCM tokens have the FCM shape');
select throws_ok($$ select public.register_native_push('webos', 'whatever-token-whatever-token-1234', repeat('D', 87), repeat('c', 22)) $$,
  '23514', null, 'unknown providers are refused');
select throws_ok($$ select public.register_native_push('fcm', 'fcmtoken-bob2-' || repeat('x', 140), 'not-a-key', repeat('c', 22)) $$,
  '23514', null, 'the device public key must be a P-256 point');
select throws_ok($$ insert into public.native_push_devices (user_id, provider, token, p256dh, auth)
  values (pg_temp.uid('bob'), 'fcm', 'fcmtoken-direct-' || repeat('y', 140), repeat('B', 87), repeat('a', 22)) $$,
  '42501', null, 'rows are only written through register_native_push');
update public.native_push_devices set user_id = pg_temp.uid('alice'), token = 'https://evil.example.org/x';
select pg_temp.su();
select is((select count(*)::int from public.native_push_devices where user_id = pg_temp.uid('bob') and token not like '%evil%'), 3,
  'rows cannot be changed or handed to someone else (no update policy)');
select pg_temp.login('bob');

-- Others can't see or remove them.
select pg_temp.login('alice');
select is((select count(*)::int from public.native_push_devices), 0, 'others cannot see someone''s devices');
delete from public.native_push_devices;
select pg_temp.su();
select is((select count(*)::int from public.native_push_devices where user_id = pg_temp.uid('bob')), 3, 'others cannot delete someone''s devices');

-- The owner can remove one.
select pg_temp.login('bob');
delete from public.native_push_devices where provider = 'apns';
select is((select count(*)::int from public.native_push_devices), 2, 'the owner removes a device');

-- Signing in as someone else on the same phone moves the token to them.
select pg_temp.login('carol');
select lives_ok($$ select public.register_native_push('fcm', 'fcmtoken-bob-' || repeat('x', 140), repeat('E', 87), repeat('d', 22), 'Kithwall app on Android') $$,
  'the same app install can be taken over by whoever signs in there');
select pg_temp.su();
select is((select user_id from public.native_push_devices where provider = 'fcm'), pg_temp.uid('carol'), 'the token now belongs to carol');
update public.native_push_devices set user_id = pg_temp.uid('bob'), p256dh = repeat('B', 87), auth = repeat('a', 22) where provider = 'fcm';

-- Rights.
select is(has_function_privilege('anon', 'public.register_native_push(text, text, text, text, text, text)', 'execute'), false,
  'anon cannot register devices');
select is(has_function_privilege('authenticated', 'kw.has_push_target(uuid)', 'execute'), false, 'has_push_target is internal');
select is(has_function_privilege('authenticated', 'public.push_plan(text, uuid)', 'execute'), false, 'the plan stays server-only');

-- ---------------------------------------------------------------------------------------
-- Enqueue: bob only has the app (no browser subscription), and still gets a push.
-- ---------------------------------------------------------------------------------------
delete from kw.push_config;
insert into kw.push_config (dispatch_url, secret) values ('http://127.0.0.1:9/api/push/dispatch', repeat('s', 40));
create temp table q0 as select coalesce(max(id), 0) as id from net.http_request_queue;
grant select on q0 to authenticated;
select is((select count(*)::int from public.push_subscriptions where user_id = pg_temp.uid('bob')), 0, 'bob has no browser subscription');

select pg_temp.login('alice');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 1, '{"ct":"x"}') $$,
  'a message to an app-only person inserts');
select lives_ok($$ insert into public.notifications (id, recipient_id, actor_id, type)
  values ('63000000-0000-0000-0000-000000000001', pg_temp.uid('bob'), pg_temp.uid('alice'), 'poke') $$,
  'a notification to an app-only person inserts');
select lives_ok($$ insert into public.notifications (id, recipient_id, actor_id, type)
  values ('63000000-0000-0000-0000-000000000002', pg_temp.uid('carol'), pg_temp.uid('alice'), 'poke') $$,
  'a notification to someone with no devices inserts');
select pg_temp.su();
select is((select array_agg(convert_from(body, 'utf8')::jsonb order by id) from net.http_request_queue where id > (select id from q0)),
  array['{"id": "62000000-0000-0000-0000-000000000001", "kind": "message"}'::jsonb,
        '{"id": "63000000-0000-0000-0000-000000000001", "kind": "notification"}'::jsonb],
  'app-only recipients are pushed; people without any device are not');

-- ---------------------------------------------------------------------------------------
-- Dispatch plan
-- ---------------------------------------------------------------------------------------
set local role service_role;
select is((select jsonb_array_length(t -> 'native')
             from jsonb_array_elements(public.push_plan('message', '62000000-0000-0000-0000-000000000001') -> 'targets') t
            where t ->> 'user_id' = pg_temp.uid('bob')::text), 2, 'the plan lists every app install of a target');
select is((select t -> 'subs' from jsonb_array_elements(public.push_plan('message', '62000000-0000-0000-0000-000000000001') -> 'targets') t
            where t ->> 'user_id' = pg_temp.uid('bob')::text), 'null'::jsonb, 'and no browser subscriptions when there are none');
select is((select array_agg(d ->> 'provider' order by d ->> 'provider')
             from jsonb_array_elements(public.push_plan('notification', '63000000-0000-0000-0000-000000000001') -> 'targets') t,
                  jsonb_array_elements(t -> 'native') d), array['fcm', 'unifiedpush'], 'native devices carry their provider');
select ok((select bool_and(d ? 'p256dh' and d ? 'auth' and d ? 'token')
             from jsonb_array_elements(public.push_plan('notification', '63000000-0000-0000-0000-000000000001') -> 'targets') t,
                  jsonb_array_elements(t -> 'native') d), 'and the key material the server encrypts to');
reset role;

-- ---------------------------------------------------------------------------------------
-- Data map and account deletion
-- ---------------------------------------------------------------------------------------
select is((select count(*)::int from kw.data_map_columns where table_name = 'public.native_push_devices'), 10, 'every column is classified');
delete from auth.users where id = pg_temp.uid('bob');
select is((select count(*)::int from public.native_push_devices), 0, 'deleting the account removes its devices');

select * from finish();
rollback;
