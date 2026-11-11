-- Follow, Followers posts, Public posts, Explore, comment controls (migration 20261112000100_follow_public.sql,
-- docs/v2/10-follow-public.md). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000f0a1'),   -- lets people follow her
  ('ben', '00000000-0000-0000-0000-00000000f0b1'),   -- a stranger who follows Ann
  ('cat', '00000000-0000-0000-0000-00000000f0c1'),   -- Ann's connection
  ('dan', '00000000-0000-0000-0000-00000000f0d1'),   -- a stranger
  ('eve', '00000000-0000-0000-0000-00000000f0e1'),   -- a brand-new account that lets people follow
  ('zed', '00000000-0000-0000-0000-00000000f0f1'),   -- another follow-enabled account
  ('mo',  '00000000-0000-0000-0000-00000000f001'),   -- moderator
  ('r1',  '00000000-0000-0000-0000-00000000f011'), ('r2', '00000000-0000-0000-0000-00000000f012'),
  ('r3',  '00000000-0000-0000-0000-00000000f013'), ('r4', '00000000-0000-0000-0000-00000000f014');
grant select on ids to authenticated, anon;

insert into auth.users (id, email, aud, role)
  select id, name || '-follow@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub, created_at)
  select id, name || 'fpqx', repeat('A', 43), repeat('B', 43),
         case when name = 'eve' then now() else now() - interval '3 days' end from ids;
insert into public.staff_roles (user_id, role) select id, 'moderator' from ids where name = 'mo';
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'ann' and b.name = 'cat';

-- The operator settings this file relies on (a shared database may have them changed).
update public.app_settings set value = 'true'::jsonb where key = 'public_posts_enabled';
update public.app_settings set value = '24'::jsonb where key = 'public_post_min_age_hours';
update public.app_settings set value = '5'::jsonb where key = 'public_report_hide_threshold';

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
grant execute on all functions in schema pg_temp to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Turning follow on
-- ---------------------------------------------------------------------------
select is((select count(*)::int from public.profiles where follow_enabled and id in (select id from ids)), 0, 'follow is off by default');
select is(pg_temp.aud('ann', 'followers'), null, 'no followers audience until follow is turned on');

select pg_temp.login('ann');
select throws_ok($$ update public.profiles set follow_enabled = true where id = pg_temp.uid('ann') $$,
  '23514', null, 'a follow-enabled account needs a public name');
select lives_ok($$ update public.profiles set follow_enabled = true, display_name_public = 'Ann Public' where id = pg_temp.uid('ann') $$,
  'turning follow on with a public name');
select isnt(pg_temp.aud('ann', 'followers'), null, 'the followers audience is created with it');
select throws_ok($$ insert into public.audiences (owner_id, kind) values (pg_temp.uid('ann'), 'followers') $$,
  '23505', null, 'one followers audience per account');
select throws_ok($$ update public.profiles set display_name_public = null where id = pg_temp.uid('ann') $$,
  '23514', null, 'the public name cannot be cleared while follow is on');
select pg_temp.login('eve');
update public.profiles set follow_enabled = true, display_name_public = 'Eve New' where id = pg_temp.uid('eve');
select pg_temp.login('zed');
update public.profiles set follow_enabled = true, display_name_public = 'Zed Zqebra' where id = pg_temp.uid('zed');

-- ---------------------------------------------------------------------------
-- Following
-- ---------------------------------------------------------------------------
select pg_temp.login('ben');
select throws_ok($$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('dan')) $$,
  '42501', null, 'an account that did not turn follow on cannot be followed');
select throws_ok($$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('dan'), pg_temp.uid('ann')) $$,
  '42501', null, 'nobody can make someone else follow');
select lives_ok($$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('ann')) $$,
  'following is instant: no request, no approval');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ann')), 1, 'a follow-enabled profile is visible to a stranger');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('dan')), 0, 'other strangers stay invisible');
select ok(kw.is_member(pg_temp.aud('ann', 'followers'), pg_temp.uid('ben')), 'a follower is a member of the followers audience');
select ok(kw.is_member(pg_temp.aud('ann', 'followers'), pg_temp.uid('cat')), 'a connection counts as a follower');
select ok(not kw.is_member(pg_temp.aud('ann', 'followers'), pg_temp.uid('dan')), 'a stranger is not');
select ok(not kw.is_member(pg_temp.aud('ann', 'friends'), pg_temp.uid('ben')), 'following does not make a connection');
select is((select count(*)::int from public.audiences where id = pg_temp.aud('ann', 'followers')), 1, 'the follower can see the audience row (to check its key)');
select is((select followers from public.follow_info(pg_temp.uid('ann'))), 2::bigint, 'follower count: followers plus connections');
select ok((select i_follow from public.follow_info(pg_temp.uid('ann'))), 'follow_info: I follow her');
select isnt((select audience_id from public.follow_info(pg_temp.uid('ann'))), null, 'follow_info tells a follower which audience to expect a key for');

select pg_temp.login('dan');
select is((select count(*)::int from public.follows), 0, 'a stranger cannot list who follows whom');
select is((select audience_id from public.follow_info(pg_temp.uid('ann'))), null, 'a non-follower is not told the followers audience');
select pg_temp.login('ann');
select is((select count(*)::int from public.follows where followee_id = pg_temp.uid('ann')), 1, 'the account sees its followers');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ben')), 1, 'and their profiles (to hand over the key)');

-- Key deliveries: only the owner hands out the followers key.
select set_eq($$ select recipient_id from public.pending_key_deliveries() where audience_id = pg_temp.aud('ann', 'followers') $$,
  $$ select pg_temp.uid(n) from (values ('ben'), ('cat')) v(n) $$, 'the followers key is owed to followers and connections');
select lives_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.aud('ann', 'followers'), 1, pg_temp.uid('ben'), pg_temp.uid('ann'), '{"c":"x"}') $$, 'the owner delivers the key to a follower');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.aud('ann', 'followers'), 1, pg_temp.uid('dan'), pg_temp.uid('ann'), '{"c":"x"}') $$, '42501', null, 'not to someone who does not follow');
select set_eq($$ select recipient_id from public.pending_key_deliveries() where audience_id = pg_temp.aud('ann', 'followers') $$,
  $$ select pg_temp.uid('cat') $$, 'a delivered key is no longer pending');
select pg_temp.login('ben');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.aud('ann', 'followers'), 1, pg_temp.uid('cat'), pg_temp.uid('ben'), '{"c":"x"}') $$, '42501', null, 'a follower cannot hand the key on');
select ok(not kw.is_key_authority(pg_temp.aud('ann', 'followers'), pg_temp.uid('ben')), 'a follower is no key authority');

-- ---------------------------------------------------------------------------
-- Followers posts (encrypted) and Public posts
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000f1001', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', false, pg_temp.aud('ann', 'followers'), 1, '{"sig":"x","ct":"x"}') $$,
  'a Followers post');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1002', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', true, '{"sig":"x","body":{"text":"hello world"}}') $$,
  'a Public post from a follow-enabled account');
select pg_temp.login('dan');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1003', pg_temp.uid('dan'), pg_temp.uid('dan'), 'status', true, '{"sig":"x","body":{}}') $$,
  '42501', null, 'an account without follow cannot post publicly');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1003', pg_temp.uid('dan'), pg_temp.uid('ann'), 'status', true, '{"sig":"x","body":{}}') $$,
  '42501', null, 'nobody posts publicly on someone else''s profile');
select pg_temp.login('eve');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1004', pg_temp.uid('eve'), pg_temp.uid('eve'), 'status', true, '{"sig":"x","body":{}}') $$,
  '42501', null, 'a brand-new account cannot post publicly yet');
select pg_temp.su();
update public.app_settings set value = '0'::jsonb where key = 'public_post_min_age_hours';
select pg_temp.login('eve');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1004', pg_temp.uid('eve'), pg_temp.uid('eve'), 'photo', true, '{"sig":"x","body":{}}') $$,
  'the waiting period is an operator setting');
select pg_temp.su();
update public.app_settings set value = '24'::jsonb where key = 'public_post_min_age_hours';
select throws_ok($$ update public.app_settings set value = '"soon"'::jsonb where key = 'public_post_min_age_hours' $$, '22023', null, 'the settings are type-checked');

select pg_temp.login('ben');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 1, 'a follower reads the Followers post');
select pg_temp.login('cat');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 1, 'a connection reads the Followers post');
select pg_temp.login('dan');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 0, 'a stranger does not');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 1, 'any signed-in person reads the Public post');
select pg_temp.login('ben');
select set_eq($$ select id from public.feed_posts() where author_id = pg_temp.uid('ann') $$,
  $$ values ('00000000-0000-0000-0000-0000000f1001'::uuid), ('00000000-0000-0000-0000-0000000f1002'::uuid) $$,
  'the people I follow are in my home feed');
select pg_temp.login('dan');
select is((select count(*)::int from public.feed_posts() where author_id = pg_temp.uid('ann')), 0, 'public posts of people I do not follow are not');

-- Without an account
select pg_temp.anon();
select is((select count(*)::int from public.posts), 0, 'no account: the posts table itself shows nothing');
select is((select count(*)::int from public.explore_posts() where author_id = pg_temp.uid('ann')), 1, 'no account: Explore shows the public post');
select is((select count(*)::int from public.explore_posts() where id = '00000000-0000-0000-0000-0000000f1001'), 0, '...and never a Followers post');
select is((select author_username from public.public_post('00000000-0000-0000-0000-0000000f1002')), 'annfpqx', 'no account: the shareable link carries the author''s handle');
select is((select author_name from public.public_post('00000000-0000-0000-0000-0000000f1002')), 'Ann Public', '...their public name');
select is((select author_sign_pub from public.public_post('00000000-0000-0000-0000-0000000f1002')), repeat('A', 43), '...and the key to check the signature');
select is((select indexable from public.public_post('00000000-0000-0000-0000-0000000f1002')), false, 'search engines are off by default');
select is((select count(*)::int from public.public_post('00000000-0000-0000-0000-0000000f1001')), 0, 'no account: a Followers post has no public link');
select is((select count(*)::int from public.explore_posts(p_kinds => array['photo']) where id in ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-0000000f1004')), 1,
  'Explore filters by kind (the seam for a video feed)');
select throws_ok($$ select * from public.search_accounts('ann') $$, '42501', null, 'no account: no search');
select throws_ok($$ select * from public.follow_info(pg_temp.uid('ann')) $$, '42501', null, 'no account: no follow facts');

-- Media of public posts
select pg_temp.su();
insert into public.media_objects (path, owner_id, post_id, bytes) values
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2001', pg_temp.uid('ann'), '00000000-0000-0000-0000-0000000f1002', 10),
  (pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2002', pg_temp.uid('ann'), '00000000-0000-0000-0000-0000000f1001', 10);
select pg_temp.anon();
select ok(public.public_media_readable(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2001'), 'no account: files of a public post can be fetched');
select ok(not public.public_media_readable(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2002'), '...files of a Followers post cannot');
select pg_temp.login('dan');
select ok(kw.can_read_media(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2001'), 'signed in: the same file is readable');
select ok(not kw.can_read_media(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2002'), 'signed in, not following: Followers files are not');

-- Search engines: a per-account switch
select pg_temp.login('ann');
insert into public.privacy_prefs (user_id, index_public) values (pg_temp.uid('ann'), true);
select pg_temp.anon();
select is((select indexable from public.public_post('00000000-0000-0000-0000-0000000f1002')), true, 'the author can let search engines show public posts');

-- Turning follow off pauses everything public
select pg_temp.login('ann');
select throws_ok($$ update public.profiles set follow_enabled = false where id = pg_temp.uid('ann') $$, '23514', null,
  'the public name goes when follow is turned off (unless the account is in the directory)');
update public.profiles set follow_enabled = false, display_name_public = null where id = pg_temp.uid('ann');
select pg_temp.anon();
select is((select count(*)::int from public.explore_posts() where author_id = pg_temp.uid('ann')), 0, 'follow off: public posts leave Explore');
select is((select count(*)::int from public.public_post('00000000-0000-0000-0000-0000000f1002')), 0, 'follow off: the public link stops working');
select pg_temp.login('ben');
select is((select count(*)::int from public.posts where author_id = pg_temp.uid('ann')), 0, 'follow off: followers read nothing');
select pg_temp.login('cat');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 1, 'follow off: connections still read Followers posts');
select pg_temp.login('ann');
select is((select count(*)::int from public.posts where author_id = pg_temp.uid('ann')), 2, 'follow off: the author keeps everything');
update public.profiles set follow_enabled = true, display_name_public = 'Ann Public' where id = pg_temp.uid('ann');
select pg_temp.login('ben');
select is((select count(*)::int from public.posts where author_id = pg_temp.uid('ann')), 2, 'follow on again: followers are back');

-- ---------------------------------------------------------------------------
-- Search and suggestions
-- ---------------------------------------------------------------------------
select pg_temp.login('dan');
select set_eq($$ select username from public.search_accounts('fpqx') $$, $$ values ('annfpqx'), ('evefpqx'), ('zedfpqx') $$,
  'search returns only accounts that let people follow them');
select set_eq($$ select username from public.search_accounts('zqebra') $$, $$ values ('zedfpqx') $$, 'search matches the public name');
select set_eq($$ select username from public.search_accounts('@annfp') $$, $$ values ('annfpqx') $$, 'search matches the start of a @handle');
select is((select count(*)::int from public.search_accounts('%')), 0, 'one character is not a search');
select is((select count(*)::int from public.search_accounts('a_n')), 0, 'wildcards are taken literally');

select pg_temp.login('cat');
insert into public.follows (follower_id, followee_id) values (pg_temp.uid('cat'), pg_temp.uid('zed'));
select pg_temp.login('ann');
select set_eq($$ select username, follower_id from public.connections_following() $$,
  $$ select 'zedfpqx', pg_temp.uid('cat') $$, 'suggestions: what my connections follow');
select is((select count(*)::int from public.follows where follower_id = pg_temp.uid('cat')), 1, 'a connection''s follows are visible to me');
select pg_temp.login('ben');
select is((select count(*)::int from public.connections_following()), 0, 'not to people who are not their connections');
select pg_temp.login('cat');
insert into public.privacy_prefs (user_id, show_following) values (pg_temp.uid('cat'), false);
select pg_temp.login('ann');
select is((select count(*)::int from public.connections_following()), 0, '"Show who I follow to my connections" off: nothing is shared');
select is((select count(*)::int from public.follows where follower_id = pg_temp.uid('cat')), 0, '...in the table either');

-- ---------------------------------------------------------------------------
-- Comment controls
-- ---------------------------------------------------------------------------
select pg_temp.login('dan');
select lives_ok($$ insert into public.comments (id, post_id, author_id, envelope) values ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f1002', pg_temp.uid('dan'), '{"sig":"x","body":{"text":"hi"}}') $$,
  'by default everyone who can see a post can comment');
select pg_temp.login('ann');
update public.privacy_prefs set comment_policy = 'followers' where user_id = pg_temp.uid('ann');
select pg_temp.login('dan');
select throws_ok($$ insert into public.comments (id, post_id, author_id, envelope) values ('00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f1002', pg_temp.uid('dan'), '{"sig":"x","body":{}}') $$,
  '42501', null, 'account setting "followers": a stranger cannot comment');
select is((select can_comment from public.comment_gates(array['00000000-0000-0000-0000-0000000f1002'::uuid])), false, 'the app is told so');
select pg_temp.login('ben');
select lives_ok($$ insert into public.comments (id, post_id, author_id, envelope) values ('00000000-0000-0000-0000-0000000f3003', '00000000-0000-0000-0000-0000000f1002', pg_temp.uid('ben'), '{"sig":"x","body":{"text":"from ben"}}') $$,
  '...a follower can');
select pg_temp.login('ann');
update public.posts set comment_policy = 'connections' where id = '00000000-0000-0000-0000-0000000f1002';
select is((select edited_at from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), null, 'changing who can comment is not an edit');
select pg_temp.login('ben');
select throws_ok($$ insert into public.comments (id, post_id, author_id, envelope) values ('00000000-0000-0000-0000-0000000f3004', '00000000-0000-0000-0000-0000000f1002', pg_temp.uid('ben'), '{"sig":"x","body":{}}') $$,
  '42501', null, 'the post''s own setting wins: "connections" keeps a follower out');
select pg_temp.login('cat');
select ok((select can_comment from public.comment_gates(array['00000000-0000-0000-0000-0000000f1002'::uuid])), '...and lets a connection in');
select pg_temp.login('ann');
update public.posts set comment_policy = 'nobody' where id = '00000000-0000-0000-0000-0000000f1002';
select pg_temp.login('cat');
select ok(not (select can_comment from public.comment_gates(array['00000000-0000-0000-0000-0000000f1002'::uuid])), '"nobody": comments are off');
select pg_temp.login('ann');
select ok((select can_comment from public.comment_gates(array['00000000-0000-0000-0000-0000000f1002'::uuid])), 'the author can always comment');
update public.posts set comment_policy = 'everyone' where id = '00000000-0000-0000-0000-0000000f1002';
select lives_ok($$ delete from public.comments where id = '00000000-0000-0000-0000-0000000f3001' $$, 'the author removes a comment on their post');
select is((select count(*)::int from public.comments where id = '00000000-0000-0000-0000-0000000f3001'), 0, '...and it is gone');

-- Restrict
select lives_ok($$ insert into public.restrictions (owner_id, target_id) values (pg_temp.uid('ann'), pg_temp.uid('ben')) $$, 'restricting a follower');
select is((select count(*)::int from public.comments where id = '00000000-0000-0000-0000-0000000f3003'), 1, 'the author still sees a restricted person''s comment');
select pg_temp.login('ben');
select is((select count(*)::int from public.comments where id = '00000000-0000-0000-0000-0000000f3003'), 1, 'so does the restricted person');
select is((select count(*)::int from public.restrictions), 0, '...who is not told about the restriction');
select pg_temp.login('cat');
select is((select count(*)::int from public.comments where id = '00000000-0000-0000-0000-0000000f3003'), 0, 'nobody else sees it');
select is((select count(*)::int from public.comment_authors('00000000-0000-0000-0000-0000000f1002')), 0, '...or its author');
select pg_temp.anon();
select is((select count(*)::int from public.public_comments('00000000-0000-0000-0000-0000000f1002')), 0, 'no account: restricted comments are left out');
select is((select comment_count from public.public_post('00000000-0000-0000-0000-0000000f1002')), 0::bigint, '...and not counted');
select pg_temp.login('ann');
delete from public.restrictions where target_id = pg_temp.uid('ben');
select pg_temp.anon();
select is((select author_username from public.public_comments('00000000-0000-0000-0000-0000000f1002')), 'benfpqx', 'no account: public comments come with their author');
select pg_temp.login('cat');
select is((select username from public.comment_authors('00000000-0000-0000-0000-0000000f1002')), 'benfpqx', 'readers of a wide post get the commenters they could not list otherwise');

-- Mentions
select ok(kw.may_mention(pg_temp.uid('cat'), pg_temp.uid('ann')), 'a connection may mention me');
select ok(kw.may_mention(pg_temp.uid('dan'), pg_temp.uid('ann')), 'follow-enabled, "everyone": a stranger may mention me');
select ok(not kw.may_mention(pg_temp.uid('ann'), pg_temp.uid('dan')), 'an account without follow is only mentioned by people it is connected to');
select pg_temp.login('ann');
update public.privacy_prefs set mention_policy = 'followers' where user_id = pg_temp.uid('ann');
select ok(not kw.may_mention(pg_temp.uid('dan'), pg_temp.uid('ann')), '"followers": not a stranger');
select ok(kw.may_mention(pg_temp.uid('ben'), pg_temp.uid('ann')), '"followers": a follower');
update public.privacy_prefs set mention_policy = 'nobody' where user_id = pg_temp.uid('ann');
select ok(not kw.may_mention(pg_temp.uid('cat'), pg_temp.uid('ann')), '"nobody": not even a connection');
update public.privacy_prefs set mention_policy = 'everyone' where user_id = pg_temp.uid('ann');

-- Notifications between strangers
select pg_temp.login('ben');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id) values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'follow', 'profile', pg_temp.uid('ben')) $$,
  'a new follower can say so');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id) values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'comment', 'post', '00000000-0000-0000-0000-0000000f1002') $$,
  'a comment on a public post reaches its author');
select pg_temp.login('dan');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id) values (pg_temp.uid('ann'), pg_temp.uid('dan'), 'follow', 'profile', pg_temp.uid('dan')) $$,
  '42501', null, 'no follow, no "started following you"');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id) values (pg_temp.uid('ann'), pg_temp.uid('dan'), 'like', 'post', '00000000-0000-0000-0000-0000000f1002') $$,
  '42501', null, 'a like that was never made cannot be announced');

-- ---------------------------------------------------------------------------
-- Removing a follower, blocking
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ delete from public.follows where follower_id = pg_temp.uid('ben') and followee_id = pg_temp.uid('ann') $$, 'the account removes a follower');
select pg_temp.login('ben');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 0, 'a removed follower no longer reads Followers posts');
select ok(not kw.is_member(pg_temp.aud('ann', 'followers'), pg_temp.uid('ben')), '...and gets no new keys');
insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('ann'));
insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('zed'));
select pg_temp.login('ann');
insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ann'), pg_temp.uid('zed'));
insert into public.blocks (blocker, blocked) values (pg_temp.uid('ann'), pg_temp.uid('ben'));
select is((select count(*)::int from public.follows where follower_id = pg_temp.uid('ben') and followee_id = pg_temp.uid('ann')), 0, 'blocking removes the follow');
select pg_temp.login('ben');
select is((select count(*)::int from public.follows where follower_id = pg_temp.uid('ben')), 1, '...and only that one');
select is((select count(*)::int from public.posts where author_id = pg_temp.uid('ann')), 0, 'blocked: neither Followers nor Public posts');
select is((select count(*)::int from public.explore_posts() where author_id = pg_temp.uid('ann')), 0, 'blocked: not in Explore');
select is((select count(*)::int from public.search_accounts('annfpqx')), 0, 'blocked: not in search');
select throws_ok($$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ben'), pg_temp.uid('ann')) $$,
  '42501', null, 'blocked: cannot follow again');

-- ---------------------------------------------------------------------------
-- Rate limits
-- ---------------------------------------------------------------------------
select pg_temp.su();
insert into kw.rate_events (user_id, action) select pg_temp.uid('dan'), 'follow' from generate_series(1, 200);
insert into kw.rate_events (user_id, action) select pg_temp.uid('zed'), 'public_post' from generate_series(1, 20);
select pg_temp.login('dan');
select throws_ok($$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('dan'), pg_temp.uid('ann')) $$,
  'P0429', null, 'follows are rate limited');
select pg_temp.login('zed');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000f1009', pg_temp.uid('zed'), pg_temp.uid('zed'), 'status', true, '{"sig":"x","body":{}}') $$,
  'P0429', null, 'public posts are rate limited');

-- ---------------------------------------------------------------------------
-- Reports: hidden after enough different reporters, until a moderator reviews it
-- ---------------------------------------------------------------------------
select pg_temp.su();
update public.app_settings set value = '3'::jsonb where key = 'public_report_hide_threshold';
select pg_temp.login('r1');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r1'), 'post', '00000000-0000-0000-0000-0000000f1002', 'spam');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r1'), 'post', '00000000-0000-0000-0000-0000000f1002', 'hate');
select pg_temp.login('r2');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r2'), 'post', '00000000-0000-0000-0000-0000000f1002', 'spam');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 1, 'two accounts (three reports) do not hide a post');
select pg_temp.login('r3');
select lives_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r3'), 'post', '00000000-0000-0000-0000-0000000f1002', 'spam') $$,
  'the third account reports it');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 0, 'the post is hidden from everyone else');
select pg_temp.anon();
select is((select count(*)::int from public.public_post('00000000-0000-0000-0000-0000000f1002')), 0, '...also without an account');
select ok(not public.public_media_readable(pg_temp.uid('ann') || '/00000000-0000-0000-0000-0000000f2001'), '...and so are its files');
select pg_temp.login('ann');
select isnt((select public_hidden_at from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), null, 'its author still sees it, marked hidden');
select throws_ok($$ update public.posts set public_hidden_at = null where id = '00000000-0000-0000-0000-0000000f1002' $$,
  '42501', null, 'the author cannot unhide it');
select throws_ok($$ select public.mod_restore_public_post((select id from public.reports limit 1), 'fine') $$, '42501', null, 'only moderators restore');
select pg_temp.login('mo');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 1, 'moderators can read the hidden post');
select is((select count(*)::int from public.reports where target_id = '00000000-0000-0000-0000-0000000f1002' and status = 'open'), 4, 'and its reports');
select is((select stored_envelope -> 'body' ->> 'text' from public.reports where target_id = '00000000-0000-0000-0000-0000000f1002' limit 1), 'hello world',
  'a report on a public post carries its plain text for moderators');
select lives_ok($$ select public.mod_restore_public_post((select id from public.reports where target_id = '00000000-0000-0000-0000-0000000f1002' limit 1), 'Reviewed: within the rules.') $$,
  'a moderator restores it');
select is((select count(*)::int from public.reports where target_id = '00000000-0000-0000-0000-0000000f1002' and status = 'open'), 0, 'its open reports are closed');
select pg_temp.login('r4');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 1, 'the post is public again');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('r4'), 'post', '00000000-0000-0000-0000-0000000f1002', 'spam');
select is((select count(*)::int from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), 1, 'a reviewed post is not hidden automatically again');
select pg_temp.login('ann');
select isnt((select public_reviewed_at from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), null, 'the review is remembered');
update public.posts set envelope = '{"sig":"y","body":{"text":"changed"}}' where id = '00000000-0000-0000-0000-0000000f1002';
select is((select public_reviewed_at from public.posts where id = '00000000-0000-0000-0000-0000000f1002'), null, '...until the post is edited: new content can be reported afresh');
select pg_temp.su();
update public.app_settings set value = '1'::jsonb where key = 'public_report_hide_threshold';
select pg_temp.login('cat');
insert into public.reports (reporter_id, target_kind, target_id, reason) values (pg_temp.uid('cat'), 'post', '00000000-0000-0000-0000-0000000f1001', 'spam');
select pg_temp.su();
select is((select public_hidden_at from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), null, 'encrypted posts are never hidden by report counts');

-- ---------------------------------------------------------------------------
-- Popular ranking uses public signals only
-- ---------------------------------------------------------------------------
select pg_temp.login('dan');
insert into public.likes (target_kind, target_id, user_id) values ('post', '00000000-0000-0000-0000-0000000f1002', pg_temp.uid('dan'));
select pg_temp.anon();
select is((select id from public.explore_posts('popular') where id in ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-0000000f1004') limit 1),
  '00000000-0000-0000-0000-0000000f1002'::uuid, 'a liked, commented post ranks above a silent one');
select is((select like_count from public.public_post('00000000-0000-0000-0000-0000000f1002')), 1::bigint, 'public like count');
select pg_temp.su();
select is((select count(*)::int from kw.rate_events where action like '%explore%' or action like '%view%'), 0, 'reading Explore leaves no record');

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('anon', 'public.explore_posts(text, text[], timestamptz, int, int, uuid)', 'execute'), 'Explore works without an account');
select ok(has_function_privilege('anon', 'public.public_post(uuid)', 'execute'), 'so does a public link');
select ok(not has_function_privilege('anon', 'public.search_accounts(text, int)', 'execute'), 'search needs an account');
select ok(not has_function_privilege('anon', 'public.connections_following()', 'execute'), 'suggestions need an account');
select ok(not has_function_privilege('authenticated', 'kw.public_posts(uuid, text, text[], timestamptz, int, int, uuid, uuid)', 'execute'), 'the internal reader is not callable (it takes a viewer id)');
select ok(not has_table_privilege('anon', 'public.follows', 'select'), 'the follow graph is closed to people without an account');
select ok((select relrowsecurity from pg_class where oid = 'public.follows'::regclass) and (select relrowsecurity from pg_class where oid = 'public.restrictions'::regclass), 'row level security is on');

select * from finish();
rollback;
