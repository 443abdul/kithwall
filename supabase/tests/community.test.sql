-- Community RLS tests (groups, events, pages, Kithville). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice; Bob and Dave are Alice's friends; Carol is a stranger to Alice; Bob is friends with Carol and Dave.
create temp table cids (name text primary key, id uuid);
insert into cids values
  ('alice', '00000000-0000-0000-0000-0000000005a1'), ('bob', '00000000-0000-0000-0000-0000000005b1'),
  ('carol', '00000000-0000-0000-0000-0000000005c1'), ('dave', '00000000-0000-0000-0000-0000000005d1');
grant select on cids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, 'e' || name || '@test.local', 'authenticated', 'authenticated' from cids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, 'e' || name || 'x', repeat('A', 43), repeat('B', 43) from cids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from cids a, cids b where (a.name = 'alice' and b.name in ('bob', 'dave')) or (a.name = 'bob' and b.name in ('carol', 'dave'));

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from cids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Fixed ids for the objects under test.
create temp table oid (name text primary key, id uuid);
insert into oid values
  ('gaud', '20000000-0000-0000-0000-000000000001'), ('group', '20000000-0000-0000-0000-000000000002'),
  ('saud', '20000000-0000-0000-0000-000000000003'), ('secret', '20000000-0000-0000-0000-000000000004'),
  ('eaud', '20000000-0000-0000-0000-000000000005'), ('event', '20000000-0000-0000-0000-000000000006'),
  ('gpost', '20000000-0000-0000-0000-000000000007'), ('epost', '20000000-0000-0000-0000-000000000008'),
  ('page', '20000000-0000-0000-0000-000000000009'), ('ppost', '20000000-0000-0000-0000-00000000000a'),
  ('act', '20000000-0000-0000-0000-00000000000b');
grant select on oid to authenticated;
create function pg_temp.o(n text) returns uuid language sql security definer as $$ select id from oid where name = n $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('gaud'), pg_temp.uid('alice'), 'group') $$, 'Alice creates a group audience');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('alice'), 'admin', 'active') $$,
  'creator adds herself as admin');
select lives_ok($$ insert into public.groups (id, creator_id, audience_id, privacy, envelope, envelope_epoch)
  values (pg_temp.o('group'), pg_temp.uid('alice'), pg_temp.o('gaud'), 'closed', '{"v":1}', 1) $$, 'Alice creates a closed group');
select is((select envelope_by from public.groups where id = pg_temp.o('group')), pg_temp.uid('alice'), 'envelope_by is set to the signer');
select throws_ok($$ insert into public.groups (id, creator_id, audience_id, privacy, name_public, envelope)
  values (gen_random_uuid(), pg_temp.uid('alice'), pg_temp.o('gaud'), 'open', 'Open', '{"v":1}') $$,
  '42501', null, 'open groups are rejected while Public is off');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('bob'), 'member', 'invited') $$,
  'admin invites a friend');
select is((select invited_by from public.audience_members where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('bob')),
  pg_temp.uid('alice'), 'invited_by is recorded');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('carol'), 'member', 'invited') $$,
  '42501', null, 'cannot add a non-friend');
select lives_ok($$ insert into public.posts (id, author_id, group_id, kind, audience_id, epoch, envelope)
  values (pg_temp.o('gpost'), pg_temp.uid('alice'), pg_temp.o('group'), 'status', pg_temp.o('gaud'), 1, '{"v":1}') $$, 'member posts in the group');
select lives_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (pg_temp.o('gaud'), 1, pg_temp.uid('bob'), pg_temp.uid('alice'), '{"v":1}') $$, 'admin seals the key to an invitee');
select is((select count(*)::int from public.community_key_gaps(pg_temp.o('gaud'))), 0, 'no key gaps once the invitee holds every epoch');

select pg_temp.login('carol');
select is((select count(*)::int from public.groups where id = pg_temp.o('group')), 0, 'stranger cannot see a closed group');
select is((select count(*)::int from public.posts where id = pg_temp.o('gpost')), 0, 'stranger cannot read group posts');
select is((select count(*)::int from public.audience_members where audience_id = pg_temp.o('gaud')), 0, 'stranger cannot list members');
select is((select privacy from public.group_preview(pg_temp.o('group'))), 'closed', 'link preview reveals only that the group is closed');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('carol'), 'member', 'active') $$,
  '42501', null, 'cannot add yourself as an active member');
select throws_ok($$ insert into public.posts (id, author_id, group_id, kind, audience_id, epoch, envelope)
  values (gen_random_uuid(), pg_temp.uid('carol'), pg_temp.o('group'), 'status', pg_temp.o('gaud'), 1, '{"v":1}') $$, '42501', null, 'non-member cannot post');
select is(public.request_group_join(pg_temp.o('group')), 'requested', 'stranger asks to join a closed group');
select is((select count(*)::int from public.posts where id = pg_temp.o('gpost')), 0, 'a pending request does not grant reading');
select throws_ok($$ update public.audience_members set status = 'active' where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('carol') $$,
  'P0001', null, 'requesters cannot approve themselves');

select pg_temp.login('bob');
select is((select count(*)::int from public.groups where id = pg_temp.o('group')), 1, 'invitee sees the group (to decide)');
select is((select count(*)::int from public.posts where id = pg_temp.o('gpost')), 0, 'invitee cannot read posts before joining');
select lives_ok($$ update public.audience_members set status = 'active' where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('bob') $$, 'invitee accepts');
select is((select count(*)::int from public.posts where id = pg_temp.o('gpost')), 1, 'member reads group posts');
select throws_ok($$ update public.audience_members set role = 'admin' where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('bob') $$,
  'P0001', null, 'members cannot make themselves admin');
update public.audiences set current_epoch = 2 where id = pg_temp.o('gaud');
select is((select current_epoch from public.audiences where id = pg_temp.o('gaud')), 1, 'non-admin update of the epoch has no effect');
select is(public.community_needs_rotation(pg_temp.o('gaud')), false, 'rotation check is admin-only');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('dave'), 'member', 'invited') $$,
  'members may invite their own friends');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('gaud'), pg_temp.uid('dave'), 'member', 'active') $$,
  '42501', null, 'members cannot add people directly');
delete from public.audience_members where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('dave');
select is((select count(*)::int from public.audience_members where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('dave')), 1,
  'members cannot remove others');
select lives_ok($$ delete from public.audience_members where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('bob') $$, 'Bob leaves');
select is((select count(*)::int from public.posts where id = pg_temp.o('gpost')), 0, 'after leaving Bob cannot read group posts');

select pg_temp.login('alice');
select is(public.community_needs_rotation(pg_temp.o('gaud')), true, 'admin sees that an ex-member holds the current key');
select lives_ok($$ update public.audiences set current_epoch = 2 where id = pg_temp.o('gaud') and current_epoch = 1 $$, 'admin rotates');
select is(public.community_needs_rotation(pg_temp.o('gaud')), false, 'no rotation needed after advancing the epoch');
select throws_ok($$ update public.audiences set current_epoch = 4 where id = pg_temp.o('gaud') $$, 'P0001', null, 'epochs advance one at a time');
select is((select count(*)::int from public.community_key_gaps(pg_temp.o('gaud'))), 2, 'key gaps list the invited member''s missing epochs');
select lives_ok($$ update public.audience_members set status = 'active' where audience_id = pg_temp.o('gaud') and member_id = pg_temp.uid('carol') $$,
  'admin approves a request');
select throws_ok($$ update public.groups set privacy = 'open' where id = pg_temp.o('group') $$, 'P0001', null, 'encrypted groups cannot become open');
select lives_ok($$ update public.groups set privacy = 'secret' where id = pg_temp.o('group') $$, 'closed can become secret');

-- Secret groups: no previews, no requests.
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('saud'), pg_temp.uid('alice'), 'group') $$, 'secret audience');
select lives_ok($$ insert into public.groups (id, creator_id, audience_id, privacy, envelope, envelope_epoch)
  values (pg_temp.o('secret'), pg_temp.uid('alice'), pg_temp.o('saud'), 'secret', '{"v":1}', 1) $$, 'Alice creates a secret group');
select pg_temp.login('dave');
select is((select count(*)::int from public.group_preview(pg_temp.o('secret'))), 0, 'secret groups have no preview');
select throws_ok($$ select public.request_group_join(pg_temp.o('secret')) $$, 'P0002', null, 'secret groups take no requests');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('saud'), pg_temp.uid('dave'), 'member', 'requested') $$,
  '42501', null, 'direct requests to a secret group are rejected');

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values (pg_temp.o('eaud'), pg_temp.uid('alice'), 'event') $$, 'event audience');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status, rsvp) values (pg_temp.o('eaud'), pg_temp.uid('alice'), 'admin', 'active', 'yes') $$, 'host row');
select lives_ok($$ insert into public.events (id, host_id, audience_id, envelope, envelope_epoch) values (pg_temp.o('event'), pg_temp.uid('alice'), pg_temp.o('eaud'), '{"v":1}', 1) $$,
  'Alice creates a private event');
select throws_ok($$ insert into public.events (id, host_id, audience_id, is_public, public_body) values (gen_random_uuid(), pg_temp.uid('alice'), pg_temp.o('eaud'), true, '{"v":1}') $$,
  '42501', null, 'public events are rejected while Public is off');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('dave'), 'member', 'active') $$, 'host invites a friend');
select lives_ok($$ insert into public.posts (id, author_id, event_id, kind, audience_id, epoch, envelope)
  values (pg_temp.o('epost'), pg_temp.uid('alice'), pg_temp.o('event'), 'status', pg_temp.o('eaud'), 1, '{"v":1}') $$, 'host posts on the event wall');
select throws_ok($$ update public.events set is_public = true, public_body = '{"v":1}', envelope = null where id = pg_temp.o('event') $$,
  'P0001', null, 'an event cannot switch to public');

select pg_temp.login('dave');
select is((select count(*)::int from public.events where id = pg_temp.o('event')), 1, 'guest sees the event');
select is((select count(*)::int from public.posts where id = pg_temp.o('epost')), 1, 'guest reads the event wall');
select lives_ok($$ update public.audience_members set rsvp = 'maybe' where audience_id = pg_temp.o('eaud') and member_id = pg_temp.uid('dave') $$, 'guest RSVPs');
select is((select rsvp from public.audience_members where audience_id = pg_temp.o('eaud') and member_id = pg_temp.uid('dave')), 'maybe', 'RSVP stored');
select throws_ok($$ select public.request_group_join(pg_temp.o('event')) $$, 'P0002', null, 'request_group_join ignores events');

select pg_temp.login('carol');
select is((select count(*)::int from public.events where id = pg_temp.o('event')), 0, 'non-invitee cannot see the event');
select is((select count(*)::int from public.posts where id = pg_temp.o('epost')), 0, 'non-invitee cannot read the event wall');
select is((select count(*)::int from public.audience_members where audience_id = pg_temp.o('eaud')), 0, 'non-invitee cannot see the guest list');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status) values (pg_temp.o('eaud'), pg_temp.uid('carol'), 'member', 'requested') $$,
  '42501', null, 'events take no join requests');

-- ---------------------------------------------------------------------------
-- Pages
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select throws_ok($$ insert into public.pages (id, owner_id, name, category) values (pg_temp.o('page'), pg_temp.uid('alice'), 'Band', 'Music') $$,
  '42501', null, 'pages cannot be created while Public is off');
select pg_temp.su();
update public.app_settings set value = 'true'::jsonb where key = 'public_audience_enabled';
select pg_temp.login('alice');
select lives_ok($$ insert into public.pages (id, owner_id, name, category) values (pg_temp.o('page'), pg_temp.uid('alice'), 'Band', 'Music') $$, 'Alice creates a page');
select lives_ok($$ insert into public.posts (id, author_id, page_id, kind, is_public, envelope)
  values (pg_temp.o('ppost'), pg_temp.uid('alice'), pg_temp.o('page'), 'status', true, '{"v":1}') $$, 'owner posts on the page wall');
select lives_ok($$ insert into public.page_likes (page_id, user_id) values (pg_temp.o('page'), pg_temp.uid('alice')) $$, 'owner likes her page');
select pg_temp.login('bob');
select throws_ok($$ insert into public.posts (id, author_id, page_id, kind, is_public, envelope)
  values (gen_random_uuid(), pg_temp.uid('bob'), pg_temp.o('page'), 'status', true, '{"v":1}') $$, '42501', null, 'only the owner posts on a page');
select is((select count(*)::int from public.posts where id = pg_temp.o('ppost')), 1, 'page posts are public');
select lives_ok($$ insert into public.page_likes (page_id, user_id) values (pg_temp.o('page'), pg_temp.uid('bob')) $$, 'Bob likes the page');
select is((select count(*)::int from public.page_likes where page_id = pg_temp.o('page')), 1, 'Bob sees only his own like');
select is(public.page_like_count(pg_temp.o('page')), 2::bigint, 'like count includes everyone');
update public.pages set name = 'Hacked' where id = pg_temp.o('page');
select is((select name from public.pages where id = pg_temp.o('page')), 'Band', 'non-owners cannot edit a page');
select pg_temp.su();
update public.app_settings set value = 'false'::jsonb where key = 'public_audience_enabled';
select pg_temp.login('bob');
select is((select count(*)::int from public.pages where id = pg_temp.o('page')), 0, 'pages disappear when Public is turned off');

-- ---------------------------------------------------------------------------
-- Kithville
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ insert into public.game_state (user_id, blob) values (pg_temp.uid('alice'), 'AQ') $$, 'Alice saves her farm');
select throws_ok($$ insert into public.game_state (user_id, blob) values (pg_temp.uid('bob'), 'AQ') $$, '42501', null, 'cannot create someone else''s farm');
select throws_ok($$ update public.game_state set blob = 'AQx', version = 1 where user_id = pg_temp.uid('alice') $$, '40001', null, 'stale saves are rejected');
select lives_ok($$ update public.game_state set blob = 'AQx', version = 2 where user_id = pg_temp.uid('alice') $$, 'saving the next version works');
select lives_ok($$ insert into public.game_actions (id, from_id, to_id, kind, sealed) values (pg_temp.o('act'), pg_temp.uid('alice'), pg_temp.uid('bob'), 'gift', '{"v":1}') $$,
  'send a gift to a friend');
select throws_ok($$ insert into public.game_actions (id, from_id, to_id, kind, sealed) values (gen_random_uuid(), pg_temp.uid('alice'), pg_temp.uid('bob'), 'gift', '{"v":1}') $$,
  'P0429', null, 'one gift per neighbor per day');
select throws_ok($$ insert into public.game_actions (id, from_id, to_id, kind, sealed) values (gen_random_uuid(), pg_temp.uid('alice'), pg_temp.uid('carol'), 'help', '{"v":1}') $$,
  '42501', null, 'cannot send to a non-friend');
select pg_temp.login('bob');
select is((select count(*)::int from public.game_state), 0, 'nobody else can read your farm');
select is((select count(*)::int from public.game_actions where to_id = pg_temp.uid('bob')), 1, 'recipient sees the gift');
select throws_ok($$ update public.game_actions set sealed = '{"v":2}' where id = pg_temp.o('act') $$, 'P0001', null, 'gift payload is immutable');
select lives_ok($$ update public.game_actions set claimed_at = now() where id = pg_temp.o('act') $$, 'recipient claims the gift');
select throws_ok($$ update public.game_actions set claimed_at = now() where id = pg_temp.o('act') $$, 'P0001', null, 'a gift is claimed once');
select pg_temp.login('carol');
select is((select count(*)::int from public.game_actions), 0, 'others cannot see neighbor actions');

select * from finish();
rollback;
