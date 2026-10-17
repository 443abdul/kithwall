-- Messages & chat: re-key marker, leaving / ownership hand-over, and the private Realtime
-- inbox policies on realtime.messages. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice & Bob are friends; Carol is a stranger to both; Dave is Alice's friend.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000004a1'), ('bob', '00000000-0000-0000-0000-0000000004b0'),
  ('carol', '00000000-0000-0000-0000-0000000004c0'), ('dave', '00000000-0000-0000-0000-0000000004d0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-msg@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'msgt', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'dave');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
-- What Realtime does to authorise a client on a private channel: set the topic, then try the
-- read (select) or write (insert) against realtime.messages under the user's role.
create function pg_temp.topic(n text) returns void language plpgsql as $$
begin perform set_config('realtime.topic', 'inbox:' || pg_temp.uid(n)::text, true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------------------
-- Realtime inbox policies
-- ---------------------------------------------------------------------------------------
-- A broadcast already sitting on Bob's inbox (as Realtime would store it).
insert into realtime.messages (topic, extension, event, payload, private)
  values ('inbox:' || pg_temp.uid('bob')::text, 'broadcast', 'sig', '{}'::jsonb, true);

select pg_temp.login('bob'); select pg_temp.topic('bob');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 1, 'owner can receive on own inbox');

select pg_temp.login('alice'); select pg_temp.topic('bob');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'a friend cannot receive on someone else''s inbox');
select lives_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{"k":"on"}', true) $$, 'a friend may send to the inbox');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'presence', 'sig', '{}', true) $$, '42501', null, 'presence extension is not allowed on inboxes');

select pg_temp.login('carol'); select pg_temp.topic('bob');
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'a stranger cannot receive on another inbox');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'a stranger cannot send to an inbox');

select pg_temp.login('carol');
select set_config('realtime.topic', 'inbox:not-a-uuid', true);
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'malformed inbox topics are rejected');
select set_config('realtime.topic', 'inbox:' || pg_temp.uid('carol')::text, true);
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'nobody signals their own inbox');

-- ---------------------------------------------------------------------------------------
-- Group conversation: Alice (owner) + Bob + Carol (Carol is not Alice's friend; owners may add anyone)
-- ---------------------------------------------------------------------------------------
select pg_temp.login('alice');
insert into public.audiences (id, owner_id, kind) values ('40000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  values ('40000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'admin', 'active', pg_temp.uid('alice'));
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  values ('40000000-0000-0000-0000-000000000001', pg_temp.uid('bob'), 'member', 'active', pg_temp.uid('alice')),
         ('40000000-0000-0000-0000-000000000001', pg_temp.uid('carol'), 'member', 'active', pg_temp.uid('alice')) $$,
  'owner adds members (including a non-friend)');
select lives_ok($$ insert into public.conversations (id, audience_id, created_by)
  values ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', pg_temp.uid('alice')) $$,
  'owner starts the conversation');
select is((select rekey_needed from public.conversations where id = '41000000-0000-0000-0000-000000000001'), false,
  'a new conversation needs no re-key');
insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 1, '{"v":1}');

-- Co-members may now signal each other (typing) even though they are not friends.
select pg_temp.login('carol'); select pg_temp.topic('bob');
select lives_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{"k":"typing"}', true) $$, 'a conversation co-member may signal');

-- Members can't hand over or rewrite the conversation.
select pg_temp.login('bob');
select throws_ok($$ select public.leave_conversation('41000000-0000-0000-0000-000000000099') $$, '42501', null,
  'cannot leave a conversation you are not in');
update public.audiences set owner_id = pg_temp.uid('bob') where id = '40000000-0000-0000-0000-000000000001';
select pg_temp.su();
select is((select owner_id from public.audiences where id = '40000000-0000-0000-0000-000000000001'), pg_temp.uid('alice'),
  'a member cannot take ownership');

-- Carol leaves: re-key needed; she loses access; no more signalling to Bob.
select pg_temp.login('carol');
select lives_ok($$ select public.leave_conversation('41000000-0000-0000-0000-000000000001') $$, 'a member leaves');
select is((select count(*)::int from public.messages where conversation_id = '41000000-0000-0000-0000-000000000001'), 0,
  'the leaver can no longer read messages');
select is((select count(*)::int from public.conversations where id = '41000000-0000-0000-0000-000000000001'), 0,
  'the leaver can no longer see the conversation');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values ('40000000-0000-0000-0000-000000000001', 2, pg_temp.uid('carol'), pg_temp.uid('carol'), '{}') $$, '42501', null,
  'the leaver cannot obtain new keys');
select pg_temp.topic('bob');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'the leaver can no longer signal former co-members');
select pg_temp.su();
select is((select rekey_needed from public.conversations where id = '41000000-0000-0000-0000-000000000001'), true,
  'leaving marks the conversation for re-keying');

-- Only the owner (an admin) can rotate; rotation clears the marker.
select pg_temp.login('bob');
update public.audiences set current_epoch = 2 where id = '40000000-0000-0000-0000-000000000001';
select pg_temp.su();
select is((select current_epoch from public.audiences where id = '40000000-0000-0000-0000-000000000001'), 1,
  'a plain member cannot rotate the key');
select pg_temp.login('alice');
select lives_ok($$ update public.audiences set current_epoch = 2 where id = '40000000-0000-0000-0000-000000000001' $$,
  'the owner rotates the key');
select pg_temp.su();
select is((select rekey_needed from public.conversations where id = '41000000-0000-0000-0000-000000000001'), false,
  'rotation clears the re-key marker');

-- Owner leaves: ownership passes to Bob, who becomes admin; Alice loses access.
select pg_temp.login('alice');
select lives_ok($$ select public.leave_conversation('41000000-0000-0000-0000-000000000001') $$, 'the owner leaves');
select is((select count(*)::int from public.messages where conversation_id = '41000000-0000-0000-0000-000000000001'), 0,
  'the former owner can no longer read messages');
select pg_temp.su();
select is((select owner_id from public.audiences where id = '40000000-0000-0000-0000-000000000001'), pg_temp.uid('bob'),
  'ownership is handed to a remaining member');
select is((select role from public.audience_members where audience_id = '40000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('bob')),
  'admin', 'the new owner is an admin');
select is((select rekey_needed from public.conversations where id = '41000000-0000-0000-0000-000000000001'), true,
  'the new owner is asked to re-key');
select pg_temp.login('bob');
select lives_ok($$ update public.audiences set current_epoch = 3 where id = '40000000-0000-0000-0000-000000000001' $$,
  'the new owner can rotate');

-- Last one out deletes the conversation.
select lives_ok($$ select public.leave_conversation('41000000-0000-0000-0000-000000000001') $$, 'the last member leaves');
select pg_temp.su();
select is((select count(*)::int from public.conversations where id = '41000000-0000-0000-0000-000000000001'), 0,
  'an empty conversation is deleted');
select is((select count(*)::int from public.messages where id = '42000000-0000-0000-0000-000000000001'), 0,
  'its messages are deleted too');

-- One-to-one conversations can't be left (they are archived instead).
select pg_temp.login('alice');
insert into public.audiences (id, owner_id, kind) values ('40000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  values ('40000000-0000-0000-0000-000000000002', pg_temp.uid('dave'), 'member', 'active', pg_temp.uid('alice'));
insert into public.conversations (id, audience_id, created_by, dm_key)
  values ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', pg_temp.uid('alice'),
          least(pg_temp.uid('alice')::text, pg_temp.uid('dave')::text) || ':' || greatest(pg_temp.uid('alice')::text, pg_temp.uid('dave')::text));
select throws_ok($$ select public.leave_conversation('41000000-0000-0000-0000-000000000002') $$, '22023', null,
  'one-to-one conversations cannot be left');

-- Ownership of other audience kinds stays immutable.
select throws_ok($$ update public.audiences set owner_id = pg_temp.uid('bob') where owner_id = pg_temp.uid('alice') and kind = 'friends' $$,
  'P0001', 'audience identity is immutable', 'friends audiences cannot change owner');

-- Owners can read back an audience they just created (insert … returning).
select pg_temp.login('dave');
select lives_ok($$ insert into public.audiences (owner_id, kind) values (pg_temp.uid('dave'), 'conversation') returning id $$,
  'insert … returning works for a new audience');

-- Key deliveries already made by another member are not reported as pending.
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values ('40000000-0000-0000-0000-000000000003', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status)
  values ('40000000-0000-0000-0000-000000000003', pg_temp.uid('bob'), 'member', 'active'),
         ('40000000-0000-0000-0000-000000000003', pg_temp.uid('dave'), 'member', 'active');
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values ('40000000-0000-0000-0000-000000000003', 1, pg_temp.uid('dave'), pg_temp.uid('alice'), '{}');
select pg_temp.login('bob');
select is((select count(*)::int from public.pending_key_deliveries() p
           where p.audience_id = '40000000-0000-0000-0000-000000000003' and p.recipient_id = pg_temp.uid('dave')), 0,
  'a key delivered by someone else is not pending');
select is((select count(*)::int from public.pending_key_deliveries() p
           where p.audience_id = '40000000-0000-0000-0000-000000000003' and p.recipient_id = pg_temp.uid('alice')), 1,
  'a missing key is still pending');
select pg_temp.login('carol');
select is(kw.key_delivered('40000000-0000-0000-0000-000000000003', 1, pg_temp.uid('dave')), false,
  'non-members learn nothing about key deliveries');

select * from finish();
rollback;
