-- Cross-area rules added during integration.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values ('ann', '00000000-0000-0000-0000-0000000001a1'), ('ben', '00000000-0000-0000-0000-0000000001b1'),
                       ('cat', '00000000-0000-0000-0000-0000000001c1');
grant select on ids to authenticated;
insert into auth.users (id, email, aud, role) select id, name || '@int-fixture.invalid', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, 'intfix.' || name, repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now() from ids a, ids b where a.name = 'ann' and b.name = 'ben';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.friends_aud(n text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = 'friends' $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Ben's "Wall Photos" album (his own friends audience).
select pg_temp.login('ben');
insert into public.albums (id, owner_id, audience_id, epoch, envelope)
  values ('50000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), pg_temp.friends_aud('ben'), 1, '{"v":1}');

select lives_ok($$ insert into public.photos (id, album_id, owner_id, audience_id, epoch, envelope)
  values ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', pg_temp.uid('ben'),
          pg_temp.friends_aud('ann'), 1, '{"v":1}') $$,
  'a friend may encrypt a photo to the wall owner''s friends (photo on a friend''s wall)');
select throws_ok($$ insert into public.photos (id, album_id, owner_id, audience_id, epoch, envelope)
  values ('51000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', pg_temp.uid('ben'),
          pg_temp.friends_aud('cat'), 1, '{"v":1}') $$,
  '42501', null, 'but not to a stranger''s friends audience');
select throws_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope)
  values ('50000000-0000-0000-0000-000000000002', pg_temp.uid('ben'), pg_temp.friends_aud('ann'), 1, '{"v":1}') $$,
  '42501', null, 'albums still must use the owner''s own audiences');

select pg_temp.login('ann');
select is((select count(*)::int from public.photos where id = '51000000-0000-0000-0000-000000000001'), 1,
  'the wall owner can read the photo');
select pg_temp.login('cat');
select is((select count(*)::int from public.photos), 0, 'a stranger cannot');

select * from finish();
rollback;
