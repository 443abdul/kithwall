-- Web Push: subscription & preference RLS, the private dispatch config, the enqueue triggers and the
-- server-only dispatch plan. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice is friends with everyone; Alice & Bob share a one-to-one conversation; Carol is in
-- a group conversation with them; Dave has no push subscription.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000005a1'), ('bob', '00000000-0000-0000-0000-0000000005b0'),
  ('carol', '00000000-0000-0000-0000-0000000005c0'), ('dave', '00000000-0000-0000-0000-0000000005d0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-push@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'pusht', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'carol', 'dave');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Conversations: a DM (alice, bob) and a group (alice owner, bob, carol).
insert into public.audiences (id, owner_id, kind) values
  ('50000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'conversation'),
  ('50000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  select '50000000-0000-0000-0000-000000000001', id, case when name = 'alice' then 'admin' else 'member' end, 'active', pg_temp.uid('alice')
    from ids where name in ('alice', 'bob');
insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  select '50000000-0000-0000-0000-000000000002', id, case when name = 'alice' then 'admin' else 'member' end, 'active', pg_temp.uid('alice')
    from ids where name in ('alice', 'bob', 'carol');
insert into public.conversations (id, audience_id, created_by, dm_key) values
  ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', pg_temp.uid('alice'),
   least(pg_temp.uid('alice'), pg_temp.uid('bob'))::text || ':' || greatest(pg_temp.uid('alice'), pg_temp.uid('bob'))::text),
  ('51000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), null);

-- ---------------------------------------------------------------------------------------
-- Subscriptions: owner-only
-- ---------------------------------------------------------------------------------------
select pg_temp.login('bob');
select lives_ok($$ select public.register_push_subscription('https://fcm.googleapis.com/fcm/send/bob-device-1',
  repeat('B', 87), repeat('a', 22), 'Chrome on Android') $$, 'a user registers a push subscription');
select lives_ok($$ insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (pg_temp.uid('bob'), 'https://web.push.apple.com/QGx-bob-device-2', repeat('C', 87), repeat('b', 22)) $$,
  'a user can insert their own subscription directly');
select is((select count(*)::int from public.push_subscriptions), 2, 'owner sees their subscriptions');
select throws_ok($$ insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (pg_temp.uid('carol'), 'https://fcm.googleapis.com/fcm/send/forged', repeat('B', 87), repeat('a', 22)) $$,
  '42501', null, 'cannot add a subscription for someone else');
select throws_ok($$ select public.register_push_subscription('https://evil.example.com/collect', repeat('B', 87), repeat('a', 22)) $$,
  '23514', null, 'endpoints outside the known push services are refused');
select throws_ok($$ select public.register_push_subscription('https://fcm.googleapis.com.evil.example/x', repeat('B', 87), repeat('a', 22)) $$,
  '23514', null, 'look-alike push hosts are refused');

select pg_temp.login('alice');
select is((select count(*)::int from public.push_subscriptions), 0, 'others cannot see someone''s subscriptions');
delete from public.push_subscriptions where user_id = pg_temp.uid('bob');
update public.push_subscriptions set endpoint = 'https://fcm.googleapis.com/fcm/send/hijack' where user_id = pg_temp.uid('bob');
select pg_temp.su();
select is((select count(*)::int from public.push_subscriptions where endpoint like '%hijack'), 0, 'others cannot update someone''s subscriptions');
select is((select count(*)::int from public.push_subscriptions where user_id = pg_temp.uid('bob')), 2, 'others cannot delete someone''s subscriptions');

-- Signing in as someone else on the same device moves the endpoint to them.
select pg_temp.login('alice');
select lives_ok($$ select public.register_push_subscription('https://fcm.googleapis.com/fcm/send/bob-device-1',
  repeat('D', 87), repeat('c', 22), 'Chrome on Android') $$, 'the same browser endpoint can be taken over by the signed-in user');
select pg_temp.su();
select is((select user_id from public.push_subscriptions where endpoint like '%bob-device-1'), pg_temp.uid('alice'),
  'endpoint now belongs to the user signed in on that device');
-- Put it back for the dispatch-plan tests.
update public.push_subscriptions set user_id = pg_temp.uid('bob') where endpoint like '%bob-device-1';
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (pg_temp.uid('carol'), 'https://updates.push.services.mozilla.com/wpush/v2/carol', repeat('E', 87), repeat('d', 22));

-- ---------------------------------------------------------------------------------------
-- Preferences: owner-only
-- ---------------------------------------------------------------------------------------
select pg_temp.login('carol');
select lives_ok($$ insert into public.push_preferences (user_id, messages) values (pg_temp.uid('carol'), false) $$,
  'a user stores their push preferences');
select throws_ok($$ insert into public.push_preferences (user_id) values (pg_temp.uid('bob')) $$,
  '42501', null, 'cannot set someone else''s preferences');
select pg_temp.login('bob');
select is((select count(*)::int from public.push_preferences), 0, 'others cannot read someone''s preferences');

-- ---------------------------------------------------------------------------------------
-- Private config & server-only functions
-- ---------------------------------------------------------------------------------------
select pg_temp.su();
select is(has_table_privilege('authenticated', 'kw.push_config', 'select'), false, 'authenticated cannot read kw.push_config');
select is(has_table_privilege('anon', 'kw.push_config', 'select'), false, 'anon cannot read kw.push_config');
select is(has_table_privilege('service_role', 'kw.push_config', 'select'), false, 'service_role cannot read kw.push_config');
select is(has_function_privilege('authenticated', 'public.push_plan(text, uuid)', 'execute'), false,
  'signed-in users cannot call the dispatch plan');
select is(has_function_privilege('anon', 'public.push_plan(text, uuid)', 'execute'), false, 'anon cannot call the dispatch plan');
select pg_temp.login('bob');
select throws_ok($$ select * from kw.push_config $$, '42501', null, 'reading the push config as a user fails');

-- ---------------------------------------------------------------------------------------
-- Triggers: no config -> inserts work and nothing is queued
-- ---------------------------------------------------------------------------------------
select pg_temp.su();
delete from kw.push_config;
create temp table q0 as select coalesce(max(id), 0) as id from net.http_request_queue;
grant select on q0 to authenticated;

select pg_temp.login('alice');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 1, '{}') $$,
  'messages insert normally without push config');
select lives_ok($$ insert into public.notifications (id, recipient_id, actor_id, type, object_kind, object_id)
  values ('53000000-0000-0000-0000-000000000001', pg_temp.uid('bob'), pg_temp.uid('alice'), 'poke', 'profile', pg_temp.uid('alice')) $$,
  'notifications insert normally without push config');
select pg_temp.su();
select is((select count(*)::int from net.http_request_queue where id > (select id from q0)), 0, 'nothing is queued without config');

-- ---------------------------------------------------------------------------------------
-- Triggers: with config -> one request per row, body carries only {kind, id}
-- ---------------------------------------------------------------------------------------
insert into kw.push_config (dispatch_url, secret) values ('http://127.0.0.1:9/api/push/dispatch', repeat('s', 40));
select pg_temp.login('alice');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('52000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), 1, '{"ct":"secret-ciphertext"}') $$,
  'a group message inserts with push config present');
select lives_ok($$ insert into public.notifications (id, recipient_id, actor_id, type, object_kind, object_id)
  values ('53000000-0000-0000-0000-000000000002', pg_temp.uid('bob'), pg_temp.uid('alice'), 'comment', 'post', gen_random_uuid()) $$,
  'a notification inserts with push config present');
select lives_ok($$ insert into public.notifications (id, recipient_id, actor_id, type)
  values ('53000000-0000-0000-0000-000000000003', pg_temp.uid('dave'), pg_temp.uid('alice'), 'poke') $$,
  'notifying someone without push subscriptions still works');
select pg_temp.su();
select is((select array_agg(convert_from(body, 'utf8')::jsonb order by id) from net.http_request_queue where id > (select id from q0)),
  array['{"id": "52000000-0000-0000-0000-000000000002", "kind": "message"}'::jsonb,
        '{"id": "53000000-0000-0000-0000-000000000002", "kind": "notification"}'::jsonb],
  'one request per pushable row, carrying only kind and id (none for recipients without subscriptions)');
select is((select count(*)::int from net.http_request_queue where id > (select id from q0)
            and headers ->> 'x-kw-push-secret' = repeat('s', 40)), 2, 'requests carry the dispatch secret header');

-- A failing enqueue can't break the insert either (simulate: the lookup table disappears).
alter table public.push_subscriptions rename to push_subscriptions_gone;
select pg_temp.login('alice');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('bob'), pg_temp.uid('alice'), 'poke', 'profile', pg_temp.uid('alice')) $$,
  'notification inserts survive a failing enqueue');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values (gen_random_uuid(), '51000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 1, '{}') $$,
  'message inserts survive a failing enqueue');
select pg_temp.su();
alter table public.push_subscriptions_gone rename to push_subscriptions;

-- ---------------------------------------------------------------------------------------
-- Dispatch plan (service role)
-- ---------------------------------------------------------------------------------------
select pg_temp.su();
set local role service_role;
select is((public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'actor' ->> 'username'), 'alicepusht',
  'plan names the actor by username');
select is((public.push_plan('message', '52000000-0000-0000-0000-000000000002') ->> 'group')::boolean, true, 'group conversations are flagged');
select is((public.push_plan('message', '52000000-0000-0000-0000-000000000001') ->> 'group')::boolean, false, 'DMs are not');
select is((select array_agg(t ->> 'user_id' order by t ->> 'user_id')
             from jsonb_array_elements(public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'targets') t),
  array[pg_temp.uid('bob')::text, pg_temp.uid('carol')::text], 'message targets: members with subscriptions, never the sender');
select is((select (t -> 'prefs' ->> 'messages')::boolean
             from jsonb_array_elements(public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'targets') t
            where t ->> 'user_id' = pg_temp.uid('carol')::text), false, 'targets carry their push preferences');
select is((select jsonb_array_length(t -> 'subs')
             from jsonb_array_elements(public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'targets') t
            where t ->> 'user_id' = pg_temp.uid('bob')::text), 2, 'every device of a target is included');
select is((public.push_plan('notification', '53000000-0000-0000-0000-000000000002') ->> 'type'), 'comment', 'notification plan carries the type');
select ok((select (t ->> 'badge')::int >= 2 from jsonb_array_elements(public.push_plan('notification', '53000000-0000-0000-0000-000000000002') -> 'targets') t),
  'targets carry an unread badge count');
select is(public.push_plan('message', gen_random_uuid()), null, 'unknown rows produce no plan');
select is(public.push_plan('bogus', '52000000-0000-0000-0000-000000000001'), null, 'unknown kinds produce no plan');
reset role;

-- A user who left the conversation is not a target.
select pg_temp.su();
delete from public.audience_members where audience_id = '50000000-0000-0000-0000-000000000002' and member_id = pg_temp.uid('carol');
set local role service_role;
select is((select array_agg(t ->> 'user_id') from jsonb_array_elements(public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'targets') t),
  array[pg_temp.uid('bob')::text], 'members who left are skipped');
reset role;

-- Blocking stops message pushes to the blocker.
select pg_temp.su();
insert into public.blocks (blocker, blocked) values (pg_temp.uid('bob'), pg_temp.uid('alice'));
set local role service_role;
select is(jsonb_array_length(public.push_plan('message', '52000000-0000-0000-0000-000000000002') -> 'targets'), 0, 'blocked senders don''t reach the blocker');
reset role;

select * from finish();
rollback;
