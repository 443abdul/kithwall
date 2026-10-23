-- Live profile changes (migration 20261031000100_profile_info_live.sql): a profile_info change is announced
-- on the private db:<uid> topic of exactly the people who may read the row, with no ids or content.
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Ann's connections: Ben, Dee (whom Ann later blocks). Cal is a stranger; Fay is Ben's connection only.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-0000000b3001'), ('ben', '00000000-0000-0000-0000-0000000b3002'),
  ('cal', '00000000-0000-0000-0000-0000000b3003'), ('dee', '00000000-0000-0000-0000-0000000b3004'),
  ('fay', '00000000-0000-0000-0000-0000000b3005');
grant select on ids to authenticated, service_role;
insert into auth.users (id, email, aud, role) select id, name || '-live@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, name || 'live', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.friends(a text, b text) returns void language sql as $$
  insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid(a), pg_temp.uid(b)), greatest(pg_temp.uid(a), pg_temp.uid(b)), 'accepted', pg_temp.uid(a), now()) $$;
create function pg_temp.notices(n text) returns int language sql security definer as $$
  select count(*)::int from realtime.messages
   where topic = 'db:' || pg_temp.uid(n)::text and event = 'change' and payload ->> 't' = 'profile_info' $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.su();
select pg_temp.friends('ann', 'ben');
select pg_temp.friends('ann', 'dee');
select pg_temp.friends('ben', 'fay');
create temp table aud as select id from public.audiences where owner_id = pg_temp.uid('ann') and kind = 'friends';
grant select on aud to authenticated;

select pg_temp.login('ann');
insert into public.profile_info (user_id, audience_id, epoch, envelope, updated_at)
  values (pg_temp.uid('ann'), (select id from aud), 1, '{"v":1}', '2001-01-01T00:00:00Z');
select pg_temp.su();
select is(pg_temp.notices('ben'), 1, 'a connection hears that the profile changed');
select is(pg_temp.notices('dee'), 1, 'every connection does');
select is(pg_temp.notices('ann'), 1, 'so do the owner''s other devices');
select is(pg_temp.notices('cal'), 0, 'a stranger hears nothing');
select is(pg_temp.notices('fay'), 0, 'a connection''s connection hears nothing');
select ok((select updated_at > '2020-01-01' from public.profile_info where user_id = pg_temp.uid('ann')),
  'updated_at is set by the server, not the device clock');
select ok(not exists (select 1 from realtime.messages where payload ->> 't' = 'profile_info'
  and (payload::text like '%' || pg_temp.uid('ann')::text || '%' or payload - 't' - 'id' <> '{}'::jsonb)), 'the notice carries no user ids or content (just its own message id)');

-- Blocked people are not told (they can't read the row either).
insert into public.blocks (blocker, blocked) values (pg_temp.uid('ann'), pg_temp.uid('dee'));
select pg_temp.login('ann');
update public.profile_info set envelope = '{"v":2}' where user_id = pg_temp.uid('ann');
select pg_temp.su();
select is(pg_temp.notices('ben'), 2, 'an edit reaches connections again');
select is(pg_temp.notices('dee'), 1, 'but not someone the owner blocked');
select is(pg_temp.notices('cal'), 0, 'nor strangers');

-- Clients still can't send or listen on someone else's db: topic (authz.test.sql covers the policy).
select pg_temp.login('cal');
select set_config('realtime.topic', 'db:' || pg_temp.uid('ben')::text, true);
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'a stranger cannot read a connection''s notices');
select set_config('realtime.topic', '', true);

select * from finish();
rollback;
