-- Kithwall 2 recovery from a @handle (20261023000100_handle_recovery.sql): server-only recovery
-- challenges, the service-role RPC that opens a trusted-friend request without a session, its limits,
-- and the notifications it sends.
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('owen', '00000000-0000-0000-0000-00000000b001'),   -- recovering owner (email-less)
  ('tia',  '00000000-0000-0000-0000-00000000b002'),   -- trusted friends
  ('tom',  '00000000-0000-0000-0000-00000000b003'),
  ('tes',  '00000000-0000-0000-0000-00000000b004'),
  ('nia',  '00000000-0000-0000-0000-00000000b005');   -- no trusted friends
grant select on ids to authenticated, service_role;
insert into auth.users (id, email, aud, role)
  select id, name || '-hr@id.kithwall.invalid', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'hr', repeat('S', 43), repeat('K', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- Owen's trusted friends (2 of 3). Shares are written directly: friendship checks aren't under test here.
insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
  select pg_temp.uid('owen'), pg_temp.uid(n), '00000000-0000-0000-0000-0000000000aa', 2, '{"s":"x"}'::jsonb
  from unnest(array['tia', 'tom', 'tes']) as n;

-- ---------------------------------------------------------------------------------------
-- Recovery challenges are issued by the server only
select pg_temp.login('owen');
select throws_ok($$ select * from public.create_key_challenge('recover_account') $$, '42501', null,
  'clients cannot create recovery challenges');
select lives_ok($$ select * from public.create_key_challenge('delete_account') $$, 'other proof-of-key purposes still work');
select pg_temp.service();
select lives_ok($$ insert into public.key_challenges (user_id, purpose) values (pg_temp.uid('owen'), 'recover_account') $$,
  'the server can issue a recovery challenge');
select throws_ok($$ insert into public.key_challenges (user_id, purpose) values (pg_temp.uid('owen'), 'something_else') $$, '23514', null,
  'unknown purposes are still rejected');
select lives_ok($$ insert into public.notice_emails (kind, ref_id, user_id) values ('account_recovered', gen_random_uuid(), pg_temp.uid('owen')) $$,
  'the account_recovered notice kind exists');

-- ---------------------------------------------------------------------------------------
-- start_handle_recovery: service role only. Security review W4 (20261028010500_authz_recovery.sql):
-- limits per requester (a server-computed tag), open requests per account, no friend prompt until the
-- waiting period is over and the owner hasn't cancelled.
select pg_temp.login('owen');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43), 'tag-attacker-00000001') $$, '42501', null,
  'signed-in users cannot call start_handle_recovery');
select pg_temp.su();
set local role anon;
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43), 'tag-attacker-00000001') $$, '42501', null,
  'anonymous callers cannot call start_handle_recovery');
select pg_temp.su();

select pg_temp.service();
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('E', 43), 'tag-attacker-00000001') $$, 'P0002', null,
  'an account without trusted friends cannot start a friends recovery');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43), null) $$, '22023', null,
  'a requester tag is required');

create temp table started as select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43), 'tag-attacker-00000001');
grant select on started to service_role, authenticated;
select pg_temp.su();
select is((select threshold from started), 2, 'returns the threshold');
select is((select trustees from started), 3, 'returns the number of trusted friends');
select ok((select not_before > now() + interval '23 hours' from started), 'keeps the waiting period');
select ok((select expires_at > now() + interval '71 hours' from started), 'keeps the expiry');
select is((select status from public.recovery_requests where id = (select request_id from started)), 'pending', 'the request is pending');
select is((select count(*)::int from public.notifications where type = 'recovery_request' and actor_id = pg_temp.uid('owen')), 0,
  'W4: friends are NOT prompted while the waiting period runs');

-- Trustees don't even see it during the wait; the owner does (warning with a cancel button).
select pg_temp.login('tia');
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('owen')), 0,
  'W4: a trusted friend cannot see a request during its waiting period');
select pg_temp.login('owen');
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('owen') and status = 'pending'), 1,
  'the owner sees the open request');
select throws_ok($$ update public.recovery_requests set friends_notified_at = now() where id = (select request_id from started) $$,
  'P0001', null, 'the owner cannot fake the friend-prompt marker');
select lives_ok($$ update public.recovery_requests set status = 'cancelled' where id = (select request_id from started) $$,
  'the owner can cancel it');
select pg_temp.su();
select is((select status from public.recovery_requests where id = (select request_id from started)), 'cancelled', 'cancelled');

-- Per requester: 2 per account a day. The attacker's tag is used up, the owner's own device is not.
select pg_temp.service();
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('F', 43), 'tag-attacker-00000001') $$, 'second request from the same requester');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('G', 43), 'tag-attacker-00000001') $$, 'P0429', null,
  'W4: a third request from the same requester for the same account is refused');
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('H', 43), 'tag-owner-device-0001') $$,
  'W4: the owner can still start their own recovery after junk requests');
-- Per requester overall: 4 a day across accounts.
select pg_temp.su();
insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
  values (pg_temp.uid('nia'), pg_temp.uid('tia'), '00000000-0000-0000-0000-0000000000ab', 2, '{"s":"x"}'::jsonb);
select pg_temp.service();
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('I', 43), 'tag-attacker-00000001') $$, 'a request for another account');
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('J', 43), 'tag-attacker-00000001') $$, 'the fourth from this requester today');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('K', 43), 'tag-attacker-00000001') $$, 'P0429', null,
  'W4: a fifth request from one requester in a day is refused');

-- At most 10 OPEN requests per account, but the cap never refuses (security re-review R-W4): ten
-- requesters used to hold an account at the cap for 72 hours, so its owner could never start a recovery.
-- Now a new request at the cap supersedes the oldest open one, and one requester holds at most one.
select pg_temp.su();
update public.recovery_requests set status = 'cancelled' where owner_id = pg_temp.uid('nia') and status = 'pending';
select pg_temp.service();
select lives_ok($$ select (public.start_handle_recovery(pg_temp.uid('nia'), repeat('L', 43), 'tag-' || g || '-xxxxxxxxxxxxxx')).request_id
                   from generate_series(1, 10) g $$, 'ten open requests from ten requesters');
select pg_temp.su();
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('nia') and status = 'pending'), 10, 'the account is at the cap');
select pg_temp.service();
create temp table owner_req as select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('M', 43), 'tag-owner-new-device-01');
grant select on owner_req to service_role, authenticated;
select pg_temp.su();
select is((select status from public.recovery_requests where id = (select request_id from owner_req)), 'pending',
  'R-W4: at the cap, the owner''s new request is accepted, not refused');
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('nia') and status = 'pending'), 10,
  'R-W4: ...and the oldest open request made room (still 10 open)');
select pg_temp.service();
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('N', 43), 'tag-3-xxxxxxxxxxxxxx') $$,
  'a second request from one of the ten requesters');
select pg_temp.su();
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('nia') and status = 'pending'
             and requester_tag = 'tag-3-xxxxxxxxxxxxxx'), 1, 'R-W4: one requester holds at most one open request per account');
select ok((select count(*) from public.recovery_requests where owner_id = pg_temp.uid('nia') and status = 'pending') <= 10, 'never more than 10 open');

-- Once the waiting period is over, the friends get ONE prompt per account (however many requests are open).
select pg_temp.su();
set local session_replication_role = replica;   -- skip the immutability trigger to fast-forward time
update public.recovery_requests set not_before = now() - interval '1 minute' where owner_id = pg_temp.uid('owen') and status = 'pending';
set local session_replication_role = origin;
select kw.recovery_notify_due();
select is((select count(*)::int from public.notifications where type = 'recovery_request' and actor_id = pg_temp.uid('owen')), 3,
  'W4: after the wait, each trusted friend is prompted once');
select kw.recovery_notify_due();
select is((select count(*)::int from public.notifications where type = 'recovery_request' and actor_id = pg_temp.uid('owen')), 3,
  'W4: no repeated prompts');
select pg_temp.login('tia');
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('owen') and status = 'pending'), 2,
  'after the wait, trusted friends see the open requests');

-- Nobody can forge the prompt from a client, not even a friend (security review D2).
select pg_temp.su();
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid('tia'), pg_temp.uid('tom')), greatest(pg_temp.uid('tia'), pg_temp.uid('tom')), 'accepted', pg_temp.uid('tia'), now());
select pg_temp.login('tia');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('tom'), pg_temp.uid('tia'), 'recovery_request', 'recovery_request', gen_random_uuid()) $$, '42501', null,
  'D2: clients cannot insert recovery_request notifications');

select * from finish();
rollback;