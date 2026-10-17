-- Photos RLS + guard tests (albums, photos, tag notices, media objects, photo comments/likes).
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table pids (name text primary key, id uuid);
insert into pids values
  ('alice', '00000000-0000-0000-0000-0000000c000a'), ('bob', '00000000-0000-0000-0000-0000000c000b'),
  ('carol', '00000000-0000-0000-0000-0000000c000c');
grant select on pids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '+ptest@test.local', 'authenticated', 'authenticated' from pids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'ptest', repeat('A', 43), repeat('B', 43) from pids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from pids a, pids b where a.name = 'alice' and b.name = 'bob';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from pids where name = n $$;
create function pg_temp.aud(n text, k text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join pids on pids.id = a.owner_id where pids.name = n and a.kind = k $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Albums and photos
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000a1', pg_temp.uid('alice'), pg_temp.aud('alice', 'friends'), 1, '{"v":1}') $$,
  'Alice creates a friends album');
select lives_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000a2', pg_temp.uid('alice'), pg_temp.aud('alice', 'self'), 1, '{"v":1}') $$,
  'Alice creates an only-me album');
select throws_ok($$ insert into public.albums (id, owner_id, is_public, envelope)
  values ('c0000000-0000-0000-0000-0000000000a3', pg_temp.uid('alice'), true, '{"v":1}') $$,
  '42501', null, 'public albums are rejected while Public is off');
select throws_ok($$ insert into public.albums (id, owner_id, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000a4', pg_temp.uid('alice'), pg_temp.aud('bob', 'friends'), 1, '{"v":1}') $$,
  '42501', null, 'album must use one of the owner''s audiences');
select lives_ok($$ insert into public.photos (id, album_id, owner_id, position, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000f1', 'c0000000-0000-0000-0000-0000000000a1', pg_temp.uid('alice'), 0,
          pg_temp.aud('alice', 'friends'), 1, '{"v":1}') $$, 'Alice adds a photo');
select lives_ok($$ insert into public.photos (id, album_id, owner_id, position, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000f2', 'c0000000-0000-0000-0000-0000000000a2', pg_temp.uid('alice'), 0,
          pg_temp.aud('alice', 'self'), 1, '{"v":1}') $$, 'Alice adds an only-me photo');
select lives_ok($$ update public.photos set position = 5 where id = 'c0000000-0000-0000-0000-0000000000f1' $$,
  'owner can reorder photos');
select throws_ok($$ update public.photos set album_id = 'c0000000-0000-0000-0000-0000000000a2'
  where id = 'c0000000-0000-0000-0000-0000000000f1' $$, 'P0001', null, 'a photo cannot change album');
select throws_ok($$ update public.albums set owner_id = pg_temp.uid('bob') where id = 'c0000000-0000-0000-0000-0000000000a1' $$,
  'P0001', null, 'album owner is immutable');

-- updated_at follows photo changes
select pg_temp.su();
update public.albums set updated_at = '2000-01-01' where id = 'c0000000-0000-0000-0000-0000000000a1';
select pg_temp.login('alice');
update public.photos set envelope = '{"v":2}' where id = 'c0000000-0000-0000-0000-0000000000f1';
select ok((select updated_at > '2001-01-01' from public.albums where id = 'c0000000-0000-0000-0000-0000000000a1'),
  'editing a photo bumps the album''s updated_at');

-- media objects for the photo
select pg_temp.login('alice');
select throws_ok($$ insert into public.media_objects (path, owner_id, photo_id, bytes)
  values ('00000000-0000-0000-0000-0000000c000b/c0000000-0000-0000-0000-0000000000b9', pg_temp.uid('alice'),
          'c0000000-0000-0000-0000-0000000000f1', 100) $$, '23514', null, 'media path must be in the owner''s folder');
select lives_ok($$ insert into public.media_objects (path, owner_id, photo_id, bytes)
  values ('00000000-0000-0000-0000-0000000c000a/c0000000-0000-0000-0000-0000000000b1', pg_temp.uid('alice'),
          'c0000000-0000-0000-0000-0000000000f1', 100),
         ('00000000-0000-0000-0000-0000000c000a/c0000000-0000-0000-0000-0000000000b2', pg_temp.uid('alice'),
          'c0000000-0000-0000-0000-0000000000f2', 100) $$, 'Alice registers media for both photos');

-- ---------------------------------------------------------------------------
-- Friend vs stranger
-- ---------------------------------------------------------------------------
select pg_temp.login('bob');
select is((select count(*)::int from public.albums where owner_id = pg_temp.uid('alice')), 1, 'friend sees the friends album only');
select is((select count(*)::int from public.photos where owner_id = pg_temp.uid('alice')), 1, 'friend sees the friends photo only');
select ok(kw.can_read_media('00000000-0000-0000-0000-0000000c000a/c0000000-0000-0000-0000-0000000000b1'), 'friend can download friends photo media');
select ok(not kw.can_read_media('00000000-0000-0000-0000-0000000c000a/c0000000-0000-0000-0000-0000000000b2'), 'friend cannot download only-me media');
select throws_ok($$ insert into public.photos (id, album_id, owner_id, position, audience_id, epoch, envelope)
  values ('c0000000-0000-0000-0000-0000000000f9', 'c0000000-0000-0000-0000-0000000000a1', pg_temp.uid('bob'), 0,
          pg_temp.aud('bob', 'friends'), 1, '{"v":1}') $$, '42501', null, 'cannot add photos to someone else''s album');
update public.photos set envelope = '{"v":9}' where id = 'c0000000-0000-0000-0000-0000000000f1';
select lives_ok($$ insert into public.comments (id, photo_id, author_id, envelope)
  values ('c0000000-0000-0000-0000-0000000000c1', 'c0000000-0000-0000-0000-0000000000f1', pg_temp.uid('bob'), '{"v":1}') $$,
  'friend comments on the photo');
select lives_ok($$ insert into public.likes (target_kind, target_id, user_id)
  values ('photo', 'c0000000-0000-0000-0000-0000000000f1', pg_temp.uid('bob')) $$, 'friend likes the photo');

select pg_temp.login('carol');
select is((select count(*)::int from public.albums where owner_id = pg_temp.uid('alice')), 0, 'stranger lists no albums');
select is((select count(*)::int from public.photos where owner_id = pg_temp.uid('alice')), 0, 'stranger lists no photos');
select is((select count(*)::int from public.media_objects where owner_id = pg_temp.uid('alice')), 0, 'stranger sees no media objects');
select ok(not kw.can_read_media('00000000-0000-0000-0000-0000000c000a/c0000000-0000-0000-0000-0000000000b1'), 'stranger cannot download');
select is((select count(*)::int from public.comments where photo_id = 'c0000000-0000-0000-0000-0000000000f1'), 0, 'stranger sees no photo comments');
select throws_ok($$ insert into public.comments (id, photo_id, author_id, envelope)
  values ('c0000000-0000-0000-0000-0000000000c2', 'c0000000-0000-0000-0000-0000000000f1', pg_temp.uid('carol'), '{"v":1}') $$,
  '42501', null, 'stranger cannot comment on the photo');

select pg_temp.login('alice');
select is((select envelope->>'v' from public.photos where id = 'c0000000-0000-0000-0000-0000000000f1'), '2', 'friend cannot edit the photo');

-- ---------------------------------------------------------------------------
-- Tag notices
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.tag_notices (photo_id, tagged_id, tagger_id)
  values ('c0000000-0000-0000-0000-0000000000f1', pg_temp.uid('bob'), pg_temp.uid('alice')) $$, 'Alice tags her friend Bob');
select throws_ok($$ insert into public.tag_notices (photo_id, tagged_id, tagger_id)
  values ('c0000000-0000-0000-0000-0000000000f1', pg_temp.uid('carol'), pg_temp.uid('alice')) $$,
  '42501', null, 'cannot tag a stranger');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('bob'), pg_temp.uid('alice'), 'tag', 'photo', 'c0000000-0000-0000-0000-0000000000f1') $$,
  'tagging notifies the friend');

select pg_temp.login('bob');
select is((select status from public.tag_notices where photo_id = 'c0000000-0000-0000-0000-0000000000f1' and tagged_id = pg_temp.uid('bob')),
  'pending', 'tagged person sees the pending tag');
select lives_ok($$ update public.tag_notices set status = 'approved'
  where photo_id = 'c0000000-0000-0000-0000-0000000000f1' and tagged_id = pg_temp.uid('bob') $$, 'tagged person approves');
select throws_ok($$ update public.tag_notices set tagger_id = pg_temp.uid('bob')
  where photo_id = 'c0000000-0000-0000-0000-0000000000f1' and tagged_id = pg_temp.uid('bob') $$,
  'P0001', null, 'tag notice identity is immutable');

select pg_temp.login('carol');
select is((select count(*)::int from public.tag_notices where tagged_id = pg_temp.uid('bob')), 0, 'stranger sees no tag notices');

-- ---------------------------------------------------------------------------
-- Delete album cascades photos, comments and media links
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ delete from public.albums where id = 'c0000000-0000-0000-0000-0000000000a1' $$, 'Alice deletes the album');
select is((select count(*)::int from public.photos where album_id = 'c0000000-0000-0000-0000-0000000000a1'), 0, 'photos are gone');
select is((select count(*)::int from public.media_objects where photo_id = 'c0000000-0000-0000-0000-0000000000f1'), 0, 'media links are gone');
select pg_temp.su();
select is((select count(*)::int from public.comments where photo_id = 'c0000000-0000-0000-0000-0000000000f1'), 0, 'comments are gone');

select * from finish();
rollback;
