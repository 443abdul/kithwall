-- Calls (20261025000100_calls.sql): Realtime Authorization for call:<conversation> and ring:<user> topics,
-- call notices (start_call / call_answered), the push trigger and the TURN quota. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann & Ben have a DM; Ann, Ben and Cal a group chat; Dee is a stranger; Ann and Eve have a DM in
-- which Eve has blocked Ann; a big group of 9 (too many for a call).
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-0000000ca110'), ('ben', '00000000-0000-0000-0000-0000000ca120'),
  ('cal', '00000000-0000-0000-0000-0000000ca130'), ('dee', '00000000-0000-0000-0000-0000000ca140'),
  ('eve', '00000000-0000-0000-0000-0000000ca150'),
  ('p1', '00000000-0000-0000-0000-0000000ca161'), ('p2', '00000000-0000-0000-0000-0000000ca162'),
  ('p3', '00000000-0000-0000-0000-0000000ca163'), ('p4', '00000000-0000-0000-0000-0000000ca164'),
  ('p5', '00000000-0000-0000-0000-0000000ca165'), ('p6', '00000000-0000-0000-0000-0000000ca166');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role) select id, name || '-calls@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, name || 'calls', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.topic(t text) returns void language plpgsql as $$
begin perform set_config('realtime.topic', t, true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values
  ('ca000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'conversation'),
  ('ca000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'conversation'),
  ('ca000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'conversation'),
  ('ca000000-0000-0000-0000-000000000004', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('ca000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'admin', 'active'),
  ('ca000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 'member', 'active'),
  ('ca000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'admin', 'active'),
  ('ca000000-0000-0000-0000-000000000002', pg_temp.uid('ben'), 'member', 'active'),
  ('ca000000-0000-0000-0000-000000000002', pg_temp.uid('cal'), 'member', 'active'),
  ('ca000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'admin', 'active'),
  ('ca000000-0000-0000-0000-000000000003', pg_temp.uid('eve'), 'member', 'active');
insert into public.audience_members (audience_id, member_id, role, status)
  select 'ca000000-0000-0000-0000-000000000004', id, 'member', 'active' from ids where name not in ('dee', 'eve');
insert into public.conversations (id, audience_id, created_by, dm_key) values
  ('cb000000-0000-0000-0000-000000000001', 'ca000000-0000-0000-0000-000000000001', pg_temp.uid('ann'),
   least(pg_temp.uid('ann'), pg_temp.uid('ben'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('ben'))::text),
  ('cb000000-0000-0000-0000-000000000002', 'ca000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), null),
  ('cb000000-0000-0000-0000-000000000003', 'ca000000-0000-0000-0000-000000000003', pg_temp.uid('ann'),
   least(pg_temp.uid('ann'), pg_temp.uid('eve'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('eve'))::text),
  ('cb000000-0000-0000-0000-000000000004', 'ca000000-0000-0000-0000-000000000004', pg_temp.uid('ann'), null);
insert into public.blocks (blocker, blocked) values (pg_temp.uid('eve'), pg_temp.uid('ann'));

-- ---------------------------------------------------------------------------------------------
-- 1. Topic parsing and helpers
-- ---------------------------------------------------------------------------------------------
select is(kw.call_topic_conversation('call:cb000000-0000-0000-0000-000000000001'), 'cb000000-0000-0000-0000-000000000001'::uuid, 'call topic parses');
select is(kw.call_topic_conversation('call:nope'), null, 'malformed call topic → null');
select is(kw.call_topic_conversation('inbox:cb000000-0000-0000-0000-000000000001'), null, 'other topics are not call topics');
select is(kw.ring_owner('ring:' || pg_temp.uid('ben')), pg_temp.uid('ben'), 'ring topic parses');
select is(kw.conversation_size('cb000000-0000-0000-0000-000000000002'), 3, 'group size counts owner + members');
select is(kw.conversation_size('cb000000-0000-0000-0000-000000000004'), 9, 'the big group has 9 people');

-- ---------------------------------------------------------------------------------------------
-- 2. Realtime: call:<conversation>
-- ---------------------------------------------------------------------------------------------
insert into realtime.messages (topic, extension, event, payload, private)
  values ('call:cb000000-0000-0000-0000-000000000002', 'broadcast', 'sig', '{}'::jsonb, true);

select pg_temp.login('cal'); select pg_temp.topic('call:cb000000-0000-0000-0000-000000000002');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 1, 'a member can join the call channel');
select lives_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{"v":1}', true) $$, 'a member can signal in the call channel');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'presence', 'sig', '{}', true) $$, '42501', null, 'only broadcast is allowed on call channels');

select pg_temp.login('dee');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'a stranger cannot join a call channel');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'a stranger cannot signal in a call channel');

select pg_temp.login('ann'); select pg_temp.topic('call:cb000000-0000-0000-0000-000000000003');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'no call channel in a blocked one-to-one chat');
select pg_temp.topic('call:not-a-uuid');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'malformed call topics are rejected');

-- ---------------------------------------------------------------------------------------------
-- 3. Realtime: ring:<user>
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
insert into realtime.messages (topic, extension, event, payload, private)
  values ('ring:' || pg_temp.uid('ben')::text, 'broadcast', 'sig', '{}'::jsonb, true);
select pg_temp.login('ben'); select pg_temp.topic('ring:' || pg_temp.uid('ben')::text);
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 1, 'the owner listens on their ring topic');
select pg_temp.login('ann');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'nobody else can listen on it');
select lives_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, 'someone who shares a chat can ring');
select pg_temp.login('dee');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'a stranger cannot ring');
select pg_temp.login('ann'); select pg_temp.topic('ring:' || pg_temp.uid('eve')::text);
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'cannot ring someone who blocked you');
select pg_temp.login('ben'); select pg_temp.topic('ring:' || pg_temp.uid('ben')::text);
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'nobody rings their own topic');

-- ---------------------------------------------------------------------------------------------
-- 4. Call notices
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
create temp table calls_made (name text primary key, id uuid);
grant all on calls_made to authenticated;
insert into calls_made values ('dm', public.start_call('cb000000-0000-0000-0000-000000000001', true));
select isnt((select id from calls_made where name = 'dm'), null, 'start_call returns the notice id');
select is((select notice from public.messages where id = (select id from calls_made where name = 'dm')),
  '{"kind":"call","video":true}'::jsonb, 'the notice says only that a (video) call started');
select is((select envelope from public.messages where id = (select id from calls_made where name = 'dm')), '{}'::jsonb, 'no content is stored');
select is((select sender_id from public.messages where id = (select id from calls_made where name = 'dm')), pg_temp.uid('ann'), 'the caller is the sender');
select ok((select expires_at is not null from public.messages where id = (select id from calls_made where name = 'dm')),
  'call notices disappear with the chat timer');
select lives_ok($$ insert into calls_made values ('group', public.start_call('cb000000-0000-0000-0000-000000000002', false)) $$, 'group calls (3 people) are allowed');
select throws_ok($$ select public.start_call('cb000000-0000-0000-0000-000000000004', false) $$, '22023', null, 'calls are capped at 8 people');
select throws_ok($$ select public.start_call('cb000000-0000-0000-0000-000000000003', false) $$, '42501', null, 'no calls in a blocked one-to-one chat');
select pg_temp.login('dee');
select throws_ok($$ select public.start_call('cb000000-0000-0000-0000-000000000001', false) $$, '42501', null, 'strangers cannot start calls');
select pg_temp.login('ann');
select throws_ok($$ select public.call_answered((select id from calls_made where name = 'dm')) $$, '42501', null, 'the caller cannot mark their own call answered');
select pg_temp.login('ben');
select is((select count(*)::int from public.messages where id = (select id from calls_made where name = 'dm') and notice->>'kind' = 'call'), 1,
  'the callee sees the call notice');
update public.messages set notice = '{"kind":"call","video":false,"ans":true}' where id = (select id from calls_made where name = 'dm');
select is((select notice from public.messages where id = (select id from calls_made where name = 'dm')), '{"kind":"call","video":true}'::jsonb,
  'clients cannot edit call notices (RLS: only senders edit, and never notices)');
select lives_ok($$ select public.call_answered((select id from calls_made where name = 'dm')) $$, 'the callee marks it answered');
select lives_ok($$ select public.call_answered((select id from calls_made where name = 'dm')) $$, 'idempotent');
select is((select notice from public.messages where id = (select id from calls_made where name = 'dm')),
  '{"kind":"call","video":true,"ans":true}'::jsonb, 'answered adds only ans:true (no duration, no who)');
select throws_ok($$ select public.call_answered(gen_random_uuid()) $$, '22023', null, 'unknown calls are rejected');

-- An old call can no longer be marked answered.
select pg_temp.su();
select set_config('kw.trusted_write', 'on', true);
update public.messages set created_at = now() - interval '10 minutes' where id = (select id from calls_made where name = 'group');
select set_config('kw.trusted_write', 'off', true);
select pg_temp.login('cal');
select lives_ok($$ select public.call_answered((select id from calls_made where name = 'group')) $$, 'late answers are ignored quietly');
select is((select notice->>'ans' from public.messages where id = (select id from calls_made where name = 'group')), null, 'and change nothing');

-- ---------------------------------------------------------------------------------------------
-- 5. Push trigger, TURN quota, privileges
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
select ok(exists (select 1 from pg_trigger where tgname = 'push_on_call' and tgrelid = 'public.messages'::regclass), 'call notices trigger a push');
select ok(exists (select 1 from pg_trigger where tgname = 'push_on_message' and tgrelid = 'public.messages'::regclass), 'message pushes are still there');
select pg_temp.login('ann');
select lives_ok($$ select public.turn_quota() $$, 'signed-in users may fetch TURN credentials');
select pg_temp.su();
select ok(not has_function_privilege('anon', 'public.turn_quota()', 'execute'), 'anon cannot');
select ok(not has_function_privilege('anon', 'public.start_call(uuid, boolean)', 'execute'), 'anon cannot start calls');
select ok(not has_function_privilege('anon', 'public.call_answered(uuid)', 'execute'), 'anon cannot answer calls');
select ok((select prosecdef from pg_proc where oid = 'public.start_call(uuid, boolean)'::regprocedure), 'start_call is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.start_call(uuid, boolean)'::regprocedure), 'start_call pins search_path');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.call_answered(uuid)'::regprocedure), 'call_answered pins search_path');

select * from finish();
rollback;
