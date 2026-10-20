-- Safety check-ins (20261024000500_safety_checkins.sql): sealed alerts stay hidden from recipients
-- until the deadline, checking in deletes (or re-arms) them, only the database clock (or the owner's
-- own "alert now") releases them, and release turns them into ordinary messages. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann has a DM with Ben and one with Cal; Dee is a stranger; Cal later blocks Ann.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000c4a1'), ('ben', '00000000-0000-0000-0000-00000000c4b0'),
  ('cal', '00000000-0000-0000-0000-00000000c4c0'), ('dee', '00000000-0000-0000-0000-00000000c4d0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-checkin@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'chkin', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.dm(n_aud text, n_conv text, a text, b text) returns void language plpgsql as $$
begin
  insert into public.audiences (id, owner_id, kind) values (n_aud::uuid, pg_temp.uid(a), 'conversation');
  insert into public.audience_members (audience_id, member_id, role, status)
    values (n_aud::uuid, pg_temp.uid(a), 'admin', 'active'), (n_aud::uuid, pg_temp.uid(b), 'member', 'active');
  insert into public.conversations (id, audience_id, created_by, dm_key)
    values (n_conv::uuid, n_aud::uuid, pg_temp.uid(a),
            least(pg_temp.uid(a), pg_temp.uid(b))::text || ':' || greatest(pg_temp.uid(a), pg_temp.uid(b))::text);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.su();
select pg_temp.dm('c4000000-0000-0000-0000-000000000001', 'c4100000-0000-0000-0000-000000000001', 'ann', 'ben');
select pg_temp.dm('c4000000-0000-0000-0000-000000000002', 'c4100000-0000-0000-0000-000000000002', 'ann', 'cal');
-- A group chat Ann is in (alerts may only go to one-to-one chats).
insert into public.audiences (id, owner_id, kind) values ('c4000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status)
  values ('c4000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'admin', 'active'),
         ('c4000000-0000-0000-0000-000000000003', pg_temp.uid('ben'), 'member', 'active');
insert into public.conversations (id, audience_id, created_by) values
  ('c4100000-0000-0000-0000-000000000003', 'c4000000-0000-0000-0000-000000000003', pg_temp.uid('ann'));
-- A DM between Ben and Dee that Ann is not in.
select pg_temp.dm('c4000000-0000-0000-0000-000000000004', 'c4100000-0000-0000-0000-000000000004', 'ben', 'dee');

create function pg_temp.alert(msg text, conv text) returns jsonb language sql as $$
  select jsonb_build_object('id', msg, 'conversation_id', conv, 'epoch', 1, 'envelope', jsonb_build_object('c', 'sealed'))
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Arming
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$
  select public.create_safety_checkin(now() + interval '2 hours', false, jsonb_build_array(
    pg_temp.alert('c4200000-0000-0000-0000-000000000001', 'c4100000-0000-0000-0000-000000000001'),
    pg_temp.alert('c4200000-0000-0000-0000-000000000002', 'c4100000-0000-0000-0000-000000000002')))
$$, 'Ann arms a check-in with sealed alerts to Ben and Cal');
select is((select count(*)::int from public.safety_checkins), 1, 'the owner sees her check-in');
select is((select count(*)::int from public.safety_checkin_alerts), 2, 'the owner sees her pending alerts');

select throws_ok($$ select public.create_safety_checkin(now() + interval '1 minute', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000010', 'c4100000-0000-0000-0000-000000000001'))) $$,
  '22023', null, 'a deadline must be at least 5 minutes away');
select throws_ok($$ select public.create_safety_checkin(now() + interval '40 days', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000010', 'c4100000-0000-0000-0000-000000000001'))) $$,
  '22023', null, 'and at most 31 days away');
select throws_ok($$ select public.create_safety_checkin(now() + interval '2 hours', false, '[]'::jsonb) $$,
  '22023', null, 'at least one person must be alerted');
select throws_ok($$ select public.create_safety_checkin(now() + interval '2 hours', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000010', 'c4100000-0000-0000-0000-000000000003'))) $$,
  '42501', null, 'alerts go to one-to-one chats only (not groups)');
select throws_ok($$ select public.create_safety_checkin(now() + interval '2 hours', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000010', 'c4100000-0000-0000-0000-000000000004'))) $$,
  '42501', null, 'nobody can plant an alert in someone else''s chat');
select throws_ok($$ insert into public.safety_checkins (owner_id, due_at) values (pg_temp.uid('ann'), now() + interval '1 day') $$,
  '42501', null, 'check-ins are only created through the RPC');
select throws_ok($$ insert into public.safety_checkin_alerts (id, checkin_id, owner_id, conversation_id, epoch, envelope)
  select 'c4200000-0000-0000-0000-000000000011', id, owner_id, 'c4100000-0000-0000-0000-000000000001', 1, '{}' from public.safety_checkins limit 1 $$,
  '42501', null, 'alerts are only added through the RPC');
select throws_ok($$ update public.safety_checkins set due_at = now() - interval '1 hour' $$,
  '42501', null, 'the owner cannot move a deadline into the past by hand');
select throws_ok($$ select kw.release_due_checkins() $$, '42501', null, 'users cannot run the release job');
select throws_ok($$ select kw.release_checkin(id) from public.safety_checkins limit 1 $$, '42501', null, 'users cannot release a check-in directly');

-- ---------------------------------------------------------------------------------------------
-- 2. Hidden from recipients until the deadline
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ben');
select is((select count(*)::int from public.safety_checkins), 0, 'a recipient cannot see the check-in');
select is((select count(*)::int from public.safety_checkin_alerts), 0, 'a recipient cannot see the sealed alert');
select is((select count(*)::int from public.messages where conversation_id = 'c4100000-0000-0000-0000-000000000001'), 0,
  'nothing appears in the recipient''s chat before the deadline');
select throws_ok($$ select public.safety_check_in((select id from public.safety_checkins limit 1)) $$,
  'P0002', null, 'a recipient cannot check in for the owner');
select pg_temp.login('dee');
select is((select count(*)::int from public.safety_checkin_alerts), 0, 'strangers see nothing either');

-- The clock runs but the deadline has not passed: nothing is released.
select pg_temp.su();
select is(kw.release_due_checkins(), 0, 'nothing is released before the deadline');

-- ---------------------------------------------------------------------------------------------
-- 3. Checking in deletes a one-off check-in and its alerts
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select is(public.safety_check_in((select id from public.safety_checkins limit 1)), null, 'checking in returns no next deadline');
select pg_temp.su();
select is((select count(*)::int from public.safety_checkins where owner_id = pg_temp.uid('ann')), 0, 'the check-in is gone');
select is((select count(*)::int from public.safety_checkin_alerts where owner_id = pg_temp.uid('ann')), 0, 'its sealed alerts are deleted');

-- Cancelling (delete) works the same way.
select pg_temp.login('ann');
select public.create_safety_checkin(now() + interval '1 hour', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000020', 'c4100000-0000-0000-0000-000000000001')));
delete from public.safety_checkins;
select pg_temp.su();
select is((select count(*)::int from public.safety_checkin_alerts where owner_id = pg_temp.uid('ann')), 0, 'cancelling deletes the alerts');

-- ---------------------------------------------------------------------------------------------
-- 4. Daily check-ins move to the next day
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select public.create_safety_checkin(now() + interval '3 hours', true,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000030', 'c4100000-0000-0000-0000-000000000001')));
select is(public.safety_check_in((select id from public.safety_checkins limit 1)), now() + interval '27 hours',
  'checking in to a daily check-in moves the deadline one day on');
select is((select count(*)::int from public.safety_checkin_alerts), 1, 'and keeps the sealed alert armed');
delete from public.safety_checkins;

-- ---------------------------------------------------------------------------------------------
-- 5. Release at the deadline (pg_cron) turns the alerts into ordinary messages
-- ---------------------------------------------------------------------------------------------
select public.create_safety_checkin(now() + interval '1 hour', false, jsonb_build_array(
  pg_temp.alert('c4200000-0000-0000-0000-000000000040', 'c4100000-0000-0000-0000-000000000001'),
  pg_temp.alert('c4200000-0000-0000-0000-000000000041', 'c4100000-0000-0000-0000-000000000002')));
select pg_temp.su();
-- Cal blocks Ann before the deadline: his alert is dropped, Ben's still goes out.
insert into public.blocks (blocker, blocked) values (pg_temp.uid('cal'), pg_temp.uid('ann'));
update public.safety_checkins set due_at = now() - interval '1 minute' where owner_id = pg_temp.uid('ann');
select is(kw.release_due_checkins(), 1, 'the clock releases the due check-in (one alert; the blocked chat is skipped)');
select is((select sender_id from public.messages where id = 'c4200000-0000-0000-0000-000000000040'), pg_temp.uid('ann'),
  'the alert becomes a message from the owner, with the id it was sealed with');
select is((select envelope from public.messages where id = 'c4200000-0000-0000-0000-000000000040'), '{"c": "sealed"}'::jsonb,
  'the sealed envelope is copied unchanged (the server never sees the text)');
select ok(not exists (select 1 from public.messages where id = 'c4200000-0000-0000-0000-000000000041'), 'nothing is sent into a blocked chat');
select is((select count(*)::int from public.safety_checkin_alerts where owner_id = pg_temp.uid('ann')), 0, 'released alerts are removed');
select ok((select released_at is not null from public.safety_checkins where owner_id = pg_temp.uid('ann')), 'the check-in is marked released');
select is(kw.release_due_checkins(), 0, 'a check-in is released only once');

select pg_temp.login('ben');
select is((select count(*)::int from public.messages where id = 'c4200000-0000-0000-0000-000000000040'), 1, 'the recipient now sees the alert');
select pg_temp.login('ann');
select throws_ok($$ select public.safety_check_in((select id from public.safety_checkins limit 1)) $$,
  'P0002', null, 'checking in after release is too late');
delete from public.safety_checkins;
select pg_temp.su();
select is((select count(*)::int from public.safety_checkins where owner_id = pg_temp.uid('ann') and released_at is not null), 1,
  'a released check-in cannot be deleted by the owner (kept for a week, then removed by the clock)');

-- ---------------------------------------------------------------------------------------------
-- 6. "Alert now" is the owner's own early release
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
delete from public.blocks where blocker = pg_temp.uid('cal');
select pg_temp.login('ann');
select public.create_safety_checkin(now() + interval '6 hours', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000050', 'c4100000-0000-0000-0000-000000000002')));
select pg_temp.login('ben');
select throws_ok($$ select public.safety_checkin_alert_now('c4200000-0000-0000-0000-000000000050') $$,
  'P0002', null, 'nobody else can trigger it');
select pg_temp.login('ann');
select is(public.safety_checkin_alert_now((select id from public.safety_checkins where released_at is null)), 1, 'the owner can alert at once');
select pg_temp.login('cal');
select is((select count(*)::int from public.messages where id = 'c4200000-0000-0000-0000-000000000050'), 1, 'Cal receives it');

-- ---------------------------------------------------------------------------------------------
-- 7. Limits
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select throws_ok($$ select public.create_safety_checkin(now() + interval '1 hour', false,
  jsonb_build_array(pg_temp.alert('c4200000-0000-0000-0000-000000000040', 'c4100000-0000-0000-0000-000000000001'))) $$,
  '22023', null, 'an alert cannot reuse the id of an existing message');
select public.create_safety_checkin(now() + interval '1 hour', false,
  jsonb_build_array(pg_temp.alert(gen_random_uuid()::text, 'c4100000-0000-0000-0000-000000000001'))) from generate_series(1, 5);
select throws_ok($$ select public.create_safety_checkin(now() + interval '1 hour', false,
  jsonb_build_array(pg_temp.alert(gen_random_uuid()::text, 'c4100000-0000-0000-0000-000000000001'))) $$,
  'P0429', null, 'at most 5 armed check-ins');
select pg_temp.su();
update public.safety_checkins set due_at = now() - interval '1 minute' where owner_id = pg_temp.uid('ann') and released_at is null;
select is(kw.release_due_checkins(), 5, 'the clock releases several due check-ins in one run');

select * from finish();
rollback;
