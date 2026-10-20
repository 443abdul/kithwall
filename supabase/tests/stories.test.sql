-- Stories (20261022000300_stories.sql): who can share, who can read (live only), forced 24 h expiry,
-- private view lists, media readability, and the expiry clean-up. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice is connected to Bob; Carol is a stranger; Dave is in Alice's circle (not connected);
-- Erin is connected to Alice but blocked by her.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-00000000a5a1'), ('bob', '00000000-0000-0000-0000-00000000a5b0'),
  ('carol', '00000000-0000-0000-0000-00000000a5c0'), ('dave', '00000000-0000-0000-0000-00000000a5d0'),
  ('erin', '00000000-0000-0000-0000-00000000a5e0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-story@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'storyt', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'erin');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.friends(n text) returns uuid language sql security definer as $$
  select a.id from public.audiences a where a.owner_id = pg_temp.uid(n) and a.kind = 'friends' $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A circle (v1 group) owned by Alice with Dave as a member; Bob is not in it.
insert into public.audiences (id, owner_id, kind) values ('5a000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'group');
insert into public.audience_members (audience_id, member_id, role, status, invited_by) values
  ('5a000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'admin', 'active', pg_temp.uid('alice')),
  ('5a000000-0000-0000-0000-000000000001', pg_temp.uid('dave'), 'member', 'active', pg_temp.uid('alice'));
insert into public.groups (id, creator_id, audience_id, privacy) values
  ('5a100000-0000-0000-0000-000000000001', pg_temp.uid('alice'), '5a000000-0000-0000-0000-000000000001', 'closed');
insert into public.blocks (blocker, blocked) values (pg_temp.uid('alice'), pg_temp.uid('erin'));
-- (blocking removes the friendship; re-add it to check that the block alone hides stories)
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(pg_temp.uid('alice'), pg_temp.uid('erin')), greatest(pg_temp.uid('alice'), pg_temp.uid('erin')), 'accepted', pg_temp.uid('alice'), now();

-- ---------------------------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.stories (id, author_id, audience_id, epoch, envelope, expires_at, created_at)
  values ('5b000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), pg_temp.friends('alice'), 1, '{"c":"x"}',
          now() + interval '30 days', now() - interval '5 days') $$,
  'Alice shares a story with her connections');
select is((select expires_at - created_at from public.stories where id = '5b000000-0000-0000-0000-000000000001'),
  interval '24 hours', 'the server forces a 24 hour lifetime (client values are ignored)');
select ok((select created_at > now() - interval '1 minute' from public.stories where id = '5b000000-0000-0000-0000-000000000001'),
  'created_at is set by the server');
select lives_ok($$ insert into public.stories (id, author_id, audience_id, epoch, group_id, envelope)
  values ('5b000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), '5a000000-0000-0000-0000-000000000001', 1,
          '5a100000-0000-0000-0000-000000000001', '{"c":"y"}') $$,
  'Alice shares a story with her circle');
select throws_ok($$ insert into public.stories (id, author_id, audience_id, epoch, envelope)
  values ('5b000000-0000-0000-0000-000000000003', pg_temp.uid('bob'), pg_temp.friends('bob'), 1, '{"c":"z"}') $$,
  '42501', null, 'cannot share a story as someone else');
select throws_ok($$ insert into public.stories (id, author_id, audience_id, epoch, envelope)
  values ('5b000000-0000-0000-0000-000000000004', pg_temp.uid('alice'), pg_temp.friends('bob'), 1, '{"c":"z"}') $$,
  '42501', null, 'cannot share to someone else''s connections audience');
select throws_ok($$ insert into public.stories (id, author_id, audience_id, epoch, envelope)
  values ('5b000000-0000-0000-0000-000000000005', pg_temp.uid('alice'), '5a000000-0000-0000-0000-000000000001', 1, '{"c":"z"}') $$,
  '42501', null, 'a circle audience needs its circle');

select pg_temp.login('bob');
select throws_ok($$ insert into public.stories (id, author_id, audience_id, epoch, group_id, envelope)
  values ('5b000000-0000-0000-0000-000000000006', pg_temp.uid('bob'), '5a000000-0000-0000-0000-000000000001', 1,
          '5a100000-0000-0000-0000-000000000001', '{"c":"z"}') $$,
  '42501', null, 'cannot share to a circle you are not in');

-- ---------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('bob');
select is((select count(*)::int from public.stories), 1, 'a connection sees the connections story only');
select pg_temp.login('dave');
select is((select array_agg(id::text) from public.stories), array['5b000000-0000-0000-0000-000000000002'], 'a circle member sees the circle story only');
select pg_temp.login('carol');
select is((select count(*)::int from public.stories), 0, 'strangers see nothing');
select pg_temp.login('erin');
select is((select count(*)::int from public.stories), 0, 'blocked people see nothing');

-- Stories cannot be edited (no update policy).
select pg_temp.login('alice');
update public.stories set envelope = '{"c":"edited"}' where id = '5b000000-0000-0000-0000-000000000001';
select is((select envelope->>'c' from public.stories where id = '5b000000-0000-0000-0000-000000000001'), 'x', 'stories are immutable');
select pg_temp.login('bob');
delete from public.stories where id = '5b000000-0000-0000-0000-000000000001';
select pg_temp.su();
select is((select count(*)::int from public.stories where id = '5b000000-0000-0000-0000-000000000001'), 1, 'only the author deletes a story');

-- ---------------------------------------------------------------------------------------------
-- Views: private to the author
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('bob');
select lives_ok($$ insert into public.story_views (story_id, viewer_id) values ('5b000000-0000-0000-0000-000000000001', pg_temp.uid('bob')) $$,
  'a viewer records their view');
select is((select count(*)::int from public.story_views), 1, 'a viewer sees their own view row');
select throws_ok($$ insert into public.story_views (story_id, viewer_id) values ('5b000000-0000-0000-0000-000000000002', pg_temp.uid('bob')) $$,
  '42501', null, 'cannot record a view of a story you cannot read');
select throws_ok($$ insert into public.story_views (story_id, viewer_id) values ('5b000000-0000-0000-0000-000000000001', pg_temp.uid('carol')) $$,
  '42501', null, 'cannot record a view for someone else');
select pg_temp.login('dave');
select lives_ok($$ insert into public.story_views (story_id, viewer_id) values ('5b000000-0000-0000-0000-000000000002', pg_temp.uid('dave')) $$,
  'a circle member records a view');
select is((select count(*)::int from public.story_views where story_id = '5b000000-0000-0000-0000-000000000001'), 0,
  'other viewers cannot see who viewed a story');
select pg_temp.login('alice');
select is((select count(*)::int from public.story_views), 2, 'the author sees everyone who viewed their stories');
select throws_ok($$ insert into public.story_views (story_id, viewer_id) values ('5b000000-0000-0000-0000-000000000001', pg_temp.uid('alice')) $$,
  '42501', null, 'authors do not count as viewers of their own story');

-- ---------------------------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('alice');
insert into public.media_objects (path, owner_id, bytes, story_id) values
  (pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 100, '5b000000-0000-0000-0000-000000000001'),
  (pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), 100, '5b000000-0000-0000-0000-000000000002');
select throws_ok($$ insert into public.media_objects (path, owner_id, bytes, story_id, post_id) values
  (pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000003', pg_temp.uid('alice'), 100,
   '5b000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-0000000000ff') $$,
  '23514', null, 'a media object belongs to one item');
select pg_temp.login('bob');
select ok(kw.can_read_media(pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001'), 'a connection can read the story photo');
select ok(not kw.can_read_media(pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000002'), 'but not the circle story photo');
select pg_temp.login('carol');
select ok(not kw.can_read_media(pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001'), 'strangers cannot read story photos');

-- ---------------------------------------------------------------------------------------------
-- Expiry
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
update public.stories set expires_at = now() - interval '1 minute' where id = '5b000000-0000-0000-0000-000000000001';
select pg_temp.login('bob');
select is((select count(*)::int from public.stories), 0, 'expired stories disappear for viewers at once');
select ok(not kw.can_read_media(pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001'), 'and so does their media');
select pg_temp.login('alice');
select is((select count(*)::int from public.stories where id = '5b000000-0000-0000-0000-000000000001'), 1, 'the author still sees it until clean-up');
select throws_ok($$ select kw.story_maintenance() $$, '42501', null, 'users cannot run the clean-up');
select throws_ok($$ select * from public.expired_story_media(10) $$, '42501', null, 'users cannot list expired media');

select pg_temp.su();
select kw.story_maintenance();
select is((select count(*)::int from public.stories where id = '5b000000-0000-0000-0000-000000000001'), 0, 'the clean-up deletes expired stories');
select is((select count(*)::int from public.story_views where story_id = '5b000000-0000-0000-0000-000000000001'), 0, 'with their views');
select is((select count(*)::int from public.stories where id = '5b000000-0000-0000-0000-000000000002'), 1, 'live stories are kept');
select is((select array_agg(p) from public.expired_story_media(10) p),
  array[pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001'], 'the web cron is told which storage objects to remove');
select is(public.forget_story_media(array[pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000001',
                                          pg_temp.uid('alice')::text || '/5c000000-0000-0000-0000-000000000002']), 1,
  'forgetting media only removes rows of expired stories');
select is((select count(*)::int from public.media_objects where story_id is not null), 1, 'live story media stays');
select isnt_empty($$ select 1 from cron.job where jobname = 'kithwall-story-maintenance' $$, 'the clean-up is scheduled');

select * from finish();
rollback;
