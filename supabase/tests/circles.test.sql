-- Circles RLS tests (20261022000100_circles.sql): circle events and circle albums. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice creates a circle; Bob is Alice's friend; Carol is Bob's friend but a stranger to Alice;
-- Dave is a friend of nobody in the circle.
create temp table cids (name text primary key, id uuid);
insert into cids values
  ('alice', '00000000-0000-0000-0000-0000000007a1'), ('bob', '00000000-0000-0000-0000-0000000007b1'),
  ('carol', '00000000-0000-0000-0000-0000000007c1'), ('dave', '00000000-0000-0000-0000-0000000007d1');
grant select on cids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, 'c' || name || '@test.local', 'authenticated', 'authenticated' from cids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, 'c' || name || 'circ', repeat('A', 43), repeat('B', 43) from cids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from cids a, cids b where (a.name = 'alice' and b.name = 'bob') or (a.name = 'bob' and b.name = 'carol');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from cids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

create temp table oid (name text primary key, id uuid);
insert into oid values
  ('caud', '30000000-0000-0000-0000-000000000001'), ('circle', '30000000-0000-0000-0000-000000000002'),
  ('eaud', '30000000-0000-0000-0000-000000000003'), ('event', '30000000-0000-0000-0000-000000000004'),
  ('daud', '30000000-0000-0000-0000-000000000005'), ('album', '30000000-0000-0000-0000-000000000006'),
  ('photo', '30000000-0000-0000-0000-000000000007'), ('xaud', '30000000-0000-0000-0000-000000000008');
grant select on oid to authenticated;
create function pg_temp.o(n text) returns uuid language sql security definer as $$ select id from oid where name = n $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- A circle: secret group, Alice → Bob → Carol
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('caud'), pg_temp.uid('alice'), 'group') $$, 'circle audience');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('caud'), pg_temp.uid('alice'), 'admin', 'active') $$, 'creator is admin');
select lives_ok($$ insert into public.groups (id, creator_id, audience_id, privacy, envelope, envelope_epoch)
  values (pg_temp.o('circle'), pg_temp.uid('alice'), pg_temp.o('caud'), 'secret', '{"v":1}', 1) $$, 'Alice creates a circle (secret group)');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('caud'), pg_temp.uid('bob'), 'member', 'invited') $$, 'Alice invites Bob');
select pg_temp.login('bob');
select lives_ok($$ update public.audience_members set status = 'active' where audience_id = pg_temp.o('caud') and member_id = pg_temp.uid('bob') $$, 'Bob accepts');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('caud'), pg_temp.uid('carol'), 'member', 'invited') $$, 'Bob invites his friend Carol');
select pg_temp.login('carol');
select lives_ok($$ update public.audience_members set status = 'active' where audience_id = pg_temp.o('caud') and member_id = pg_temp.uid('carol') $$, 'Carol accepts');

-- ---------------------------------------------------------------------------
-- Circle events
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('eaud'), pg_temp.uid('alice'), 'event') $$, 'event audience');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status, rsvp) values (pg_temp.o('eaud'), pg_temp.uid('alice'), 'admin', 'active', 'yes') $$, 'host row');
select lives_ok($$ insert into public.events (id, host_id, audience_id, envelope, envelope_epoch, group_id)
  values (pg_temp.o('event'), pg_temp.uid('alice'), pg_temp.o('eaud'), '{"v":1}', 1, pg_temp.o('circle')) $$, 'member creates an event in the circle');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('carol'), 'member', 'active') $$,
  'host invites a circle member who is not her connection');
select is((select invited_by from public.audience_members where audience_id = pg_temp.o('eaud') and member_id = pg_temp.uid('carol')), pg_temp.uid('alice'), 'invited_by recorded');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('dave'), 'member', 'active') $$,
  '42501', null, 'host cannot add a stranger outside the circle');
select throws_ok($$ update public.events set group_id = null where id = pg_temp.o('event') $$, 'P0001', null, 'an event''s circle is immutable');

select pg_temp.login('bob');
select is((select count(*)::int from public.events where id = pg_temp.o('event')), 1, 'circle member sees the circle event before joining');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('bob'), 'member', 'active') $$,
  'circle member joins the circle event');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('dave'), 'member', 'active') $$,
  '42501', null, 'guest cannot add someone outside the circle');

select pg_temp.login('dave');
select is((select count(*)::int from public.events where id = pg_temp.o('event')), 0, 'outsiders cannot see circle events');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('dave'), 'member', 'active') $$,
  '42501', null, 'outsiders cannot join circle events');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('daud'), pg_temp.uid('dave'), 'event') $$, 'Dave makes an event audience');
select throws_ok($$ insert into public.events (id, host_id, audience_id, envelope, envelope_epoch, group_id)
  values (gen_random_uuid(), pg_temp.uid('dave'), pg_temp.o('daud'), '{"v":1}', 1, pg_temp.o('circle')) $$, '42501', null, 'non-members cannot add events to a circle');

-- Leaving the circle hides its events again.
select pg_temp.login('carol');
select lives_ok($$ delete from public.audience_members where audience_id = pg_temp.o('eaud') and member_id = pg_temp.uid('carol') $$, 'Carol leaves the event');
select lives_ok($$ delete from public.audience_members where audience_id = pg_temp.o('caud') and member_id = pg_temp.uid('carol') $$, 'Carol leaves the circle');
select is((select count(*)::int from public.events where id = pg_temp.o('event')), 0, 'ex-members no longer see circle events');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('carol'), 'member', 'active') $$,
  '42501', null, 'ex-members cannot rejoin circle events');

-- ---------------------------------------------------------------------------
-- Circle albums
-- ---------------------------------------------------------------------------
select pg_temp.login('bob');
select lives_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope) values (pg_temp.o('album'), pg_temp.uid('bob'), pg_temp.o('caud'), 1, '{"v":1}') $$,
  'member shares an album with the circle');
select lives_ok($$ insert into public.photos (id, album_id, owner_id, audience_id, epoch, envelope) values (pg_temp.o('photo'), pg_temp.o('album'), pg_temp.uid('bob'), pg_temp.o('caud'), 1, '{"v":1}') $$,
  'member adds a photo encrypted to the circle');
select pg_temp.login('alice');
select is((select count(*)::int from public.albums where id = pg_temp.o('album')), 1, 'other members see the circle album');
select is((select count(*)::int from public.photos where id = pg_temp.o('photo')), 1, 'other members see its photos');
select pg_temp.login('carol');
select is((select count(*)::int from public.albums where id = pg_temp.o('album')), 0, 'ex-members cannot see the circle album');
select throws_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope) values (gen_random_uuid(), pg_temp.uid('carol'), pg_temp.o('caud'), 1, '{"v":1}') $$,
  '42501', null, 'non-members cannot share albums with the circle');
select pg_temp.login('dave');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('xaud'), pg_temp.uid('dave'), 'event') $$, 'Dave makes another audience');
select throws_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope) values (gen_random_uuid(), pg_temp.uid('dave'), pg_temp.o('xaud'), 1, '{"v":1}') $$,
  '42501', null, 'albums still cannot use event audiences');

select * from finish();
rollback;
