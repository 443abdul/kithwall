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
-- start_handle_recovery: service role only
select pg_temp.login('owen');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43)) $$, '42501', null,
  'signed-in users cannot call start_handle_recovery');
select pg_temp.su();
set local role anon;
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43)) $$, '42501', null,
  'anonymous callers cannot call start_handle_recovery');
select pg_temp.su();

select pg_temp.service();
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('nia'), repeat('E', 43)) $$, 'P0002', null,
  'an account without trusted friends cannot start a friends recovery');

create temp table started as select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('E', 43));
grant select on started to service_role, authenticated;
select pg_temp.su();
select is((select threshold from started), 2, 'returns the threshold');
select is((select trustees from started), 3, 'returns the number of trusted friends');
select ok((select not_before > now() + interval '23 hours' from started), 'keeps the waiting period');
select ok((select expires_at > now() + interval '71 hours' from started), 'keeps the expiry');
select is((select status from public.recovery_requests where id = (select request_id from started)), 'pending', 'the request is pending');
select is((select count(*)::int from public.notifications
  where actor_id = pg_temp.uid('owen') and type = 'recovery_request' and object_id = (select request_id from started)), 3,
  'every trusted friend is notified');

-- The owner's own session sees the request (for the warning with a cancel button) and can cancel it.
select pg_temp.login('owen');
select is((select count(*)::int from public.recovery_requests where owner_id = pg_temp.uid('owen') and status = 'pending'), 1,
  'the owner sees the open request');
select lives_ok($$ update public.recovery_requests set status = 'cancelled' where id = (select request_id from started) $$,
  'the owner can cancel it');
select pg_temp.su();
select is((select status from public.recovery_requests where id = (select request_id from started)), 'cancelled', 'cancelled');

-- At most 3 requests per account per day (the one above counts).
select pg_temp.service();
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('F', 43)) $$, 'second request');
select lives_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('G', 43)) $$, 'third request');
select throws_ok($$ select * from public.start_handle_recovery(pg_temp.uid('owen'), repeat('H', 43)) $$, 'P0429', null,
  'a fourth request in a day is refused');

select * from finish();
rollback;
