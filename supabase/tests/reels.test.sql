-- Reels (migration 20261112000300_reels.sql, docs/v2/12-reels.md). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000e0a1'),   -- lets people follow her, posts reels
  ('ben', '00000000-0000-0000-0000-00000000e0b1'),   -- a stranger who follows Ann
  ('cat', '00000000-0000-0000-0000-00000000e0c1'),   -- Ann's connection
  ('dan', '00000000-0000-0000-0000-00000000e0d1'),   -- a stranger
  ('r1',  '00000000-0000-0000-0000-00000000e011'), ('r2', '00000000-0000-0000-0000-00000000e012');
grant select on ids to authenticated, anon;

insert into auth.users (id, email, aud, role)
  select id, name || '-reels@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub, created_at)
  select id, name || 'rlqx', repeat('A', 43), repeat('B', 43), now() - interval '3 days' from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'ann' and b.name = 'cat';

-- The operator settings this file relies on (a shared database may have them changed).
update public.app_settings set value = 'true'::jsonb where key in ('public_posts_enabled', 'reels_enabled');
update public.app_settings set value = '24'::jsonb where key = 'public_post_min_age_hours';
update public.app_settings set value = '2'::jsonb where key = 'public_report_hide_threshold';
update public.app_settings set value = '10'::jsonb where key = 'reel_daily_limit';
update public.app_settings set value = '16'::jsonb where key = 'reel_max_mb';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.aud(n text, k text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = k $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create function pg_temp.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
-- A stored file of `size` bytes, as the storage service records it after an upload.
create function pg_temp.stored(path text, size bigint) returns void language sql security definer as $$
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
  values ('media', path, split_part(path, '/', 1)::uuid, split_part(path, '/', 1), jsonb_build_object('size', size)) $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.login('ann');
update public.profiles set follow_enabled = true, display_name_public = 'Ann Reels' where id = pg_temp.uid('ann');
select pg_temp.login('ben');
insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('ann'));

-- ---------------------------------------------------------------------------
-- Posting a reel
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000e1001', pg_temp.uid('ann'), pg_temp.uid('ann'), 'reel', true, '{"sig":"x","body":{"text":"public reel"}}') $$,
  'a Public reel from a follow-enabled account');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e1002', pg_temp.uid('ann'), pg_temp.uid('ann'), 'reel', false, pg_temp.aud('ann', 'followers'), 1, '{"sig":"x","ct":"x"}') $$,
  'a Followers reel (encrypted like any Followers post)');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e1003', pg_temp.uid('ann'), pg_temp.uid('ann'), 'reel', false, pg_temp.aud('ann', 'friends'), 1, '{"sig":"x","ct":"x"}') $$,
  'a reel for connections');
select throws_ok($$ update public.posts set kind = 'video' where id = '00000000-0000-0000-0000-0000000e1003' $$, null, null,
  'a reel stays a reel (the kind of a post cannot change)');
select pg_temp.login('dan');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000e1004', pg_temp.uid('dan'), pg_temp.uid('dan'), 'reel', true, '{"sig":"x","body":{}}') $$,
  '42501', null, 'a public reel needs follow turned on, like every public post');
select pg_temp.login('cat');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e1005', pg_temp.uid('cat'), pg_temp.uid('ann'), 'reel', false, pg_temp.aud('ann', 'friends'), 1, '{"sig":"x","ct":"x"}') $$,
  '22023', null, 'no reels on someone else''s profile');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, shared_post_id, envelope)
  values ('00000000-0000-0000-0000-0000000e1006', pg_temp.uid('cat'), pg_temp.uid('cat'), 'reel', false, pg_temp.aud('cat', 'friends'), 1,
          '00000000-0000-0000-0000-0000000e1003', '{"sig":"x","ct":"x"}') $$,
  '22023', null, 'a reel is not a repost');

-- The operator's switch and the daily limit
select pg_temp.su();
update public.app_settings set value = 'false'::jsonb where key = 'reels_enabled';
select pg_temp.login('cat');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e1007', pg_temp.uid('cat'), pg_temp.uid('cat'), 'reel', false, pg_temp.aud('cat', 'friends'), 1, '{"sig":"x","ct":"x"}') $$,
  '42501', null, 'the operator can turn reels off');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e1008', pg_temp.uid('cat'), pg_temp.uid('cat'), 'video', false, pg_temp.aud('cat', 'friends'), 1, '{"sig":"x","ct":"x"}') $$,
  '...other posts are not affected');
select pg_temp.su();
update public.app_settings set value = 'true'::jsonb where key = 'reels_enabled';
update public.app_settings set value = '2'::jsonb where key = 'reel_daily_limit';
select pg_temp.login('cat');
insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope) values
  ('00000000-0000-0000-0000-0000000e1009', pg_temp.uid('cat'), pg_temp.uid('cat'), 'reel', false, pg_temp.aud('cat', 'friends'), 1, '{"sig":"x","ct":"x"}'),
  ('00000000-0000-0000-0000-0000000e100a', pg_temp.uid('cat'), pg_temp.uid('cat'), 'reel', false, pg_temp.aud('cat', 'friends'), 1, '{"sig":"x","ct":"x"}');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000e100b', pg_temp.uid('cat'), pg_temp.uid('cat'), 'reel', false, pg_temp.aud('cat', 'friends'), 1, '{"sig":"x","ct":"x"}') $$,
  'P0429', null, 'reels per day are limited per account');
select pg_temp.su();
select throws_ok($$ update public.app_settings set value = '"many"'::jsonb where key = 'reel_daily_limit' $$, '22023', null, 'the limit is type-checked');
select throws_ok($$ update public.app_settings set value = '31'::jsonb where key = 'reel_max_mb' $$, '22023', null, 'the size cap cannot exceed what the bucket stores');
select throws_ok($$ update public.app_settings set value = '1'::jsonb where key = 'reels_enabled' $$, '22023', null, 'the switch is true or false');
update public.app_settings set value = '10'::jsonb where key = 'reel_daily_limit';

-- ---------------------------------------------------------------------------
-- The size cap on a reel's files (measured from what is stored, not what the client says)
-- ---------------------------------------------------------------------------
select pg_temp.su();
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001', 6 * 1024 * 1024);      -- the video
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2002', 90 * 1024);            -- the cover
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2003', 17 * 1024 * 1024);     -- too large
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2005', 1024);
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2006', 1024);
select pg_temp.login('ann');
insert into public.media_objects (path, owner_id, bytes) values
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001', pg_temp.uid('ann'), 6 * 1024 * 1024),
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2002', pg_temp.uid('ann'), 90 * 1024),
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2003', pg_temp.uid('ann'), 1024),                -- the client lies about the size
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2004', pg_temp.uid('ann'), 1024),                -- never uploaded
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2005', pg_temp.uid('ann'), 1024),
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2006', pg_temp.uid('ann'), 1024);
select lives_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1001'
   where path in (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001', pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2002') $$,
  'a video and a cover within the cap are linked to the reel');
select throws_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1002'
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2003' $$,
  'P0413', null, 'a stored file over the cap is refused, whatever size the client claimed');
select throws_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1002'
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2004' $$,
  '22023', null, 'a file that was never uploaded cannot be linked to a reel');
select throws_ok($$ update public.media_objects set bytes = 20 * 1024 * 1024
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001' $$,
  'P0413', null, 'the cap holds on later changes too');
select lives_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1001'
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2005' $$, 'a third file is still accepted');
select pg_temp.su();
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2008', 9 * 1024 * 1024);
select pg_temp.stored(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2009', 9 * 1024 * 1024);
select pg_temp.login('ann');
insert into public.media_objects (path, owner_id, bytes) values
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2008', pg_temp.uid('ann'), 9 * 1024 * 1024),
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2009', pg_temp.uid('ann'), 9 * 1024 * 1024);
update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1003' where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2008';
select throws_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1003'
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2009' $$,
  'P0413', null, 'the cap is on a reel''s files together, so a video cannot be split to get around it');
select throws_ok($$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000e1001'
   where path = pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2006' $$,
  '22023', null, 'a reel takes no more than three files');
select ok(kw.reel_file_locked(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001'), 'a file of a reel is locked');
select ok(not kw.reel_file_locked(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2006'), 'an unlinked file is not');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner, owner_id)
  values ('media', pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001', pg_temp.uid('ann'), pg_temp.uid('ann')::text) $$,
  '42501', null, 'nothing new can be stored under the name of a reel''s file');
-- Other kinds of post keep the general limits only.
select pg_temp.login('cat');
select pg_temp.su();
select pg_temp.stored(pg_temp.uid('cat') || '/00000000-0000-0000-0000-0000000e2007', 25 * 1024 * 1024);
select pg_temp.login('cat');
select lives_ok($$ insert into public.media_objects (path, owner_id, post_id, bytes)
  values (pg_temp.uid('cat') || '/00000000-0000-0000-0000-0000000e2007', pg_temp.uid('cat'), '00000000-0000-0000-0000-0000000e1008', 25 * 1024 * 1024) $$,
  'an ordinary video post is not held to the reel cap');

-- ---------------------------------------------------------------------------
-- Who gets which reel
-- ---------------------------------------------------------------------------
select pg_temp.login('ben');
select set_eq($$ select id from public.reel_feed() $$,
  $$ values ('00000000-0000-0000-0000-0000000e1001'::uuid), ('00000000-0000-0000-0000-0000000e1002'::uuid) $$,
  'a follower gets the public and the Followers reel, not the one for connections');
select pg_temp.login('cat');
select set_eq($$ select id from public.reel_feed() $$,
  $$ values ('00000000-0000-0000-0000-0000000e1001'::uuid), ('00000000-0000-0000-0000-0000000e1002'::uuid), ('00000000-0000-0000-0000-0000000e1003'::uuid) $$,
  'a connection gets all three, and never their own reels');
select is((select count(*)::int from public.reel_feed(p_limit => 1)), 1, 'pages have the size asked for');
select is((select count(*)::int from public.reel_feed(p_before => now() - interval '1 hour')), 0, '...and continue before a time');
select pg_temp.login('dan');
select is((select count(*)::int from public.reel_feed()), 0, 'a stranger gets none from reel_feed');
select is((select count(*)::int from public.explore_posts(p_kinds => array['reel']) where author_id = pg_temp.uid('ann')), 1,
  '...and exactly the public one from Explore');
select is((select count(*)::int from public.posts where id in ('00000000-0000-0000-0000-0000000e1002', '00000000-0000-0000-0000-0000000e1003')), 0,
  '...the encrypted reels are not readable for them at all');
select ok(kw.can_read_media(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001'), 'the public reel''s video can be fetched');
select pg_temp.anon();
select is((select count(*)::int from public.explore_posts('popular', array['reel']) where author_id = pg_temp.uid('ann')), 1,
  'no account: public reels are listed (the same generic page for everyone)');
select is((select kind from public.public_post('00000000-0000-0000-0000-0000000e1001')), 'reel', 'no account: a public reel has a link');
select ok(public.public_media_readable(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001'), 'no account: its video can be fetched');
select throws_ok($$ select * from public.reel_feed() $$, '42501', null, 'no account: no feed of followed reels');

-- A block cuts reels both ways.
select pg_temp.login('ann');
insert into public.blocks (blocker, blocked) values (pg_temp.uid('ann'), pg_temp.uid('ben'));
select pg_temp.login('ben');
select is((select count(*)::int from public.reel_feed()), 0, 'blocked: nothing from reel_feed');
select is((select count(*)::int from public.explore_posts(p_kinds => array['reel']) where author_id = pg_temp.uid('ann')), 0, 'blocked: nothing from Explore');
select ok(not kw.can_read_media(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001'), 'blocked: not the video either');

-- ---------------------------------------------------------------------------
-- Safety: a reported public reel is hidden like any public post
-- ---------------------------------------------------------------------------
select pg_temp.login('r1');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r1'), 'post', '00000000-0000-0000-0000-0000000e1001', 'spam');
select pg_temp.login('r2');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r2'), 'post', '00000000-0000-0000-0000-0000000e1001', 'nudity');
select pg_temp.anon();
select is((select count(*)::int from public.explore_posts(p_kinds => array['reel']) where author_id = pg_temp.uid('ann')), 0, 'reported by enough accounts: hidden from Explore');
select ok(not public.public_media_readable(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000e2001'), '...and its video with it');
select pg_temp.login('cat');
select is((select count(*)::int from public.reel_feed() where id = '00000000-0000-0000-0000-0000000e1001'), 0, '...also for connections');

-- ---------------------------------------------------------------------------
-- The server keeps no record of watching
-- ---------------------------------------------------------------------------
select pg_temp.su();
select is((select coalesce(array_agg(table_schema || '.' || table_name order by 1), '{}') from information_schema.tables
            where table_schema in ('public', 'kw') and table_name ~* '(reel|watch|impression|view_?(event|log|count)|dwell)'),
  '{}'::text[], 'no table about reels, views, impressions or watch time exists');
select is((select coalesce(array_agg(table_name || '.' || column_name order by 1), '{}') from information_schema.columns
            where table_schema in ('public', 'kw') and column_name ~* '(watch|impression|view_?count|views|dwell|seen_reel)'),
  '{}'::text[], 'no column counts views or watch time');
select is((select count(*)::int from kw.rate_events
            where user_id in (select id from ids) and action not in ('post', 'public_post', 'reel', 'follow', 'report', 'block', 'media_upload')),
  0, 'reading the feeds left no record (only posting, following and reporting are counted)');
select is((select provolatile from pg_proc where oid = 'public.reel_feed(timestamptz, int)'::regprocedure), 's', 'reel_feed only reads');

-- ---------------------------------------------------------------------------
-- Handles and privileges
-- ---------------------------------------------------------------------------
select ok(kw.is_reserved_username('reels'), '/reels is a route: the handle is reserved');
select ok(not has_function_privilege('anon', 'public.reel_feed(timestamptz, int)', 'execute'), 'reel_feed needs an account');
select ok(not has_function_privilege('authenticated', 'kw.posts_reel_guard()', 'execute'), 'trigger functions are not callable');
select ok(not has_function_privilege('authenticated', 'kw.media_reel_guard()', 'execute'), '...');

select * from finish();
rollback;
