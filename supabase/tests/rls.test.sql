-- Row-Level Security tests. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- Fixtures (as superuser): Alice, Bob (Alice's friend), Carol (stranger),
-- Dave (Alice's friend, later blocked), Mod (moderator), Root (admin).
-- ---------------------------------------------------------------------------
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-00000000000a'), ('bob', '00000000-0000-0000-0000-00000000000b'),
  ('carol', '00000000-0000-0000-0000-00000000000c'), ('dave', '00000000-0000-0000-0000-00000000000d'),
  ('mod',   '00000000-0000-0000-0000-0000000000e0'), ('root', '00000000-0000-0000-0000-0000000000f0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '@rls-fixture.invalid', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, 'rlsfix.' || name, repeat('A', 43), repeat('B', 43) from ids;
insert into public.staff_roles (user_id, role) select id, 'moderator' from ids where name = 'mod';
insert into public.staff_roles (user_id, role) select id, 'admin' from ids where name = 'root';
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'dave');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.friends_aud(n text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = 'friends' $$;
create function pg_temp.self_aud(n text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = 'self' $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

select ok((select count(*) = 2 from public.audiences where owner_id = pg_temp.uid('alice')),
  'profile creation makes friends + self audiences');

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, 'Alice posts to her friends');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
  values ('10000000-0000-0000-0000-000000000002', pg_temp.uid('alice'), pg_temp.uid('alice'), 'status', true, '{"v":1}') $$,
  '42501', null, 'public posts are rejected while the Public audience is off');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000003', pg_temp.uid('bob'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$,
  '42501', null, 'cannot post as someone else');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000009', pg_temp.uid('alice'), pg_temp.uid('alice'), 'note',
          pg_temp.self_aud('alice'), 1, '{"v":1}') $$, 'Alice writes an only-me note');

select pg_temp.login('bob');
select is((select count(*)::int from public.posts where id = '10000000-0000-0000-0000-000000000001'), 1, 'friend reads friends post');
select is((select count(*)::int from public.posts where id = '10000000-0000-0000-0000-000000000009'), 0, 'friend cannot read only-me note');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000004', pg_temp.uid('bob'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, 'friend writes on friend''s wall with wall owner''s audience');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000005', pg_temp.uid('bob'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('bob'), 1, '{"v":1}') $$, '42501', null, 'wall post must use the wall owner''s audience');
update public.posts set envelope = '{"v":2}' where id = '10000000-0000-0000-0000-000000000001';
select pg_temp.login('alice');
select is((select envelope->>'v' from public.posts where id = '10000000-0000-0000-0000-000000000001'), '1',
  'others cannot edit a post');
select throws_ok($$ update public.posts set author_id = pg_temp.uid('bob') where id = '10000000-0000-0000-0000-000000000001' $$,
  'P0001', null, 'post identity is immutable');

select pg_temp.login('carol');
select is((select count(*)::int from public.posts), 0, 'stranger reads no posts');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('10000000-0000-0000-0000-000000000006', pg_temp.uid('carol'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, '42501', null, 'stranger cannot write on Alice''s wall');
select is((select count(*)::int from public.feed_posts()), 0, 'stranger feed is empty');

select pg_temp.login('bob');
select ok((select count(*) >= 2 from public.feed_posts()), 'friend feed includes Alice''s posts');

-- ---------------------------------------------------------------------------
-- Comments and likes
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.comments (id, post_id, author_id, envelope)
  values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', pg_temp.uid('bob'), '{"v":1}') $$,
  'friend comments');
select lives_ok($$ insert into public.likes (target_kind, target_id, user_id)
  values ('post', '10000000-0000-0000-0000-000000000001', pg_temp.uid('bob')) $$, 'friend likes');
select pg_temp.login('carol');
select throws_ok($$ insert into public.comments (id, post_id, author_id, envelope)
  values ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', pg_temp.uid('carol'), '{"v":1}') $$,
  '42501', null, 'stranger cannot comment');
select is((select count(*)::int from public.comments), 0, 'stranger reads no comments');
select is((select count(*)::int from public.likes), 0, 'stranger sees no likes');

-- ---------------------------------------------------------------------------
-- Keys
-- ---------------------------------------------------------------------------
select pg_temp.su();
insert into public.key_bundles (user_id, bundle) values (pg_temp.uid('alice'), '{"v":1}');
select pg_temp.login('bob');
select is((select count(*)::int from public.key_bundles), 0, 'nobody else reads Alice''s key bundle');
select pg_temp.login('alice');
select is((select count(*)::int from public.key_bundles), 1, 'Alice reads her own key bundle');
select results_eq($$ select recipient_id from public.pending_key_deliveries() order by 1 $$,
  $$ select id from ids where name in ('bob', 'dave') order by 1 $$, 'pending deliveries list friends lacking the key');
select lives_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.friends_aud('alice'), 1, pg_temp.uid('bob'), pg_temp.uid('alice'), '{"v":1}') $$, 'deliver key to friend');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.friends_aud('alice'), 1, pg_temp.uid('carol'), pg_temp.uid('alice'), '{"v":1}') $$,
  '42501', null, 'cannot deliver a friends key to a stranger');
select throws_ok($$ update public.audiences set current_epoch = 3 where id = pg_temp.friends_aud('alice') $$,
  'P0001', null, 'epoch cannot skip');
select lives_ok($$ update public.audiences set current_epoch = 2 where id = pg_temp.friends_aud('alice') $$, 'epoch advances by one');
select pg_temp.login('bob');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.friends_aud('alice'), 2, pg_temp.uid('dave'), pg_temp.uid('bob'), '{"v":1}') $$,
  '42501', null, 'a friend cannot distribute someone else''s friends key');

-- ---------------------------------------------------------------------------
-- Friendships, blocks, profiles
-- ---------------------------------------------------------------------------
select pg_temp.login('carol');
select lives_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('carol'), pg_temp.uid('alice')), greatest(pg_temp.uid('carol'), pg_temp.uid('alice')), pg_temp.uid('carol')) $$,
  'stranger sends a friend request');
update public.friendships set status = 'accepted' where requested_by = pg_temp.uid('carol');
select is((select status from public.friendships where requested_by = pg_temp.uid('carol')), 'pending',
  'requester cannot accept their own request');
select throws_ok($$ update public.profiles set status = 'active', suspended_until = now() where id = pg_temp.uid('carol') $$,
  'P0001', null, 'users cannot change their own moderation status');

select pg_temp.login('alice');
select lives_ok($$ insert into public.blocks (blocker, blocked) values (pg_temp.uid('alice'), pg_temp.uid('dave')) $$, 'Alice blocks Dave');
select is((select count(*)::int from public.friendships where pg_temp.uid('dave') in (user_a, user_b)), 0, 'blocking removes the friendship');
select pg_temp.login('dave');
select is((select count(*)::int from public.posts where author_id = pg_temp.uid('alice')), 0, 'blocked user reads nothing');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('alice')), 0, 'blocked user cannot see the profile');

-- Unfriend: Bob loses access
select pg_temp.login('bob');
select lives_ok($$ delete from public.friendships where pg_temp.uid('bob') in (user_a, user_b) and pg_temp.uid('alice') in (user_a, user_b) $$, 'Bob unfriends Alice');
select is((select count(*)::int from public.posts where id = '10000000-0000-0000-0000-000000000001'), 0, 'ex-friend loses access');
select pg_temp.su();
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid('alice'), pg_temp.uid('bob')), greatest(pg_temp.uid('alice'), pg_temp.uid('bob')), 'accepted', pg_temp.uid('alice'), now());

-- ---------------------------------------------------------------------------
-- Messages and notifications
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
insert into public.audiences (id, owner_id, kind) values ('30000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 'conversation');
insert into public.audience_members (audience_id, member_id) values ('30000000-0000-0000-0000-000000000001', pg_temp.uid('bob'));
select lives_ok($$ insert into public.conversations (id, audience_id, created_by)
  values ('31000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', pg_temp.uid('alice')) $$, 'start a conversation');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('32000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), 1, '{"v":1}') $$, 'send a message');
select pg_temp.login('bob');
select is((select count(*)::int from public.messages), 1, 'member reads messages');
select pg_temp.login('carol');
select is((select count(*)::int from public.messages), 0, 'non-member reads no messages');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('32000000-0000-0000-0000-000000000002', '31000000-0000-0000-0000-000000000001', pg_temp.uid('carol'), 1, '{"v":1}') $$,
  '42501', null, 'non-member cannot send');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type)
  values (pg_temp.uid('bob'), pg_temp.uid('carol'), 'poke') $$, '42501', null, 'strangers cannot notify people');
select pg_temp.login('alice');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type) values (pg_temp.uid('bob'), pg_temp.uid('alice'), 'poke') $$,
  'friends can notify each other');
select throws_ok($$ insert into public.pokes (from_id, to_id) values (pg_temp.uid('alice'), pg_temp.uid('carol')) $$,
  '42501', null, 'cannot poke a stranger');

-- ---------------------------------------------------------------------------
-- Recovery
-- ---------------------------------------------------------------------------
select lives_ok($$ insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
  values (pg_temp.uid('alice'), pg_temp.uid('bob'), gen_random_uuid(), 2, '{"v":1}') $$, 'Alice makes Bob a trustee');
select throws_ok($$ insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
  values (pg_temp.uid('alice'), pg_temp.uid('carol'), gen_random_uuid(), 2, '{"v":1}') $$,
  '42501', null, 'trustees must be friends');
insert into public.recovery_requests (id, owner_id, eph_pub) values ('40000000-0000-0000-0000-000000000001', pg_temp.uid('alice'), repeat('C', 43));
select ok((select not_before > now() + interval '23 hours' from public.recovery_requests where id = '40000000-0000-0000-0000-000000000001'),
  'recovery requests wait 24 hours');
select pg_temp.login('bob');
select throws_ok($$ insert into public.recovery_responses (request_id, trustee_id, sealed)
  values ('40000000-0000-0000-0000-000000000001', pg_temp.uid('bob'), '{"v":1}') $$,
  '42501', null, 'trustee cannot respond before the waiting period');
select pg_temp.login('carol');
select is((select count(*)::int from public.recovery_requests), 0, 'non-trustees cannot see recovery requests');

-- ---------------------------------------------------------------------------
-- Reports, staff, settings
-- ---------------------------------------------------------------------------
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('carol'), 'post', '10000000-0000-0000-0000-000000000001', 'spam') $$,
  'P0001', null, 'cannot report what you cannot see');
select pg_temp.login('bob');
select lives_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  values (pg_temp.uid('bob'), 'post', '10000000-0000-0000-0000-000000000001', 'spam', '{"text":"x"}') $$, 'friend reports a post');
select pg_temp.login('mod');
select ok((select stored_envelope is not null and target_owner_id = pg_temp.uid('alice') from public.reports where reporter_id = pg_temp.uid('bob') limit 1),
  'report snapshots ciphertext and owner for moderators');
select is((select count(*)::int from public.posts), 0, 'moderators do not get blanket read access to posts');
select throws_ok($$ select public.grant_staff_role(pg_temp.uid('carol'), 'moderator') $$, '42501', null, 'moderators cannot appoint staff');
update public.app_settings set value = 'true' where key = 'public_audience_enabled';
select is((select value::text from public.app_settings where key = 'public_audience_enabled'), 'false',
  'only admins change settings');
select pg_temp.login('root');
select lives_ok($$ select public.grant_staff_role(pg_temp.uid('carol'), 'moderator') $$, 'admin appoints a moderator');

select * from finish();
rollback;
