-- Social area tests (reserved usernames, link-preview quota, friend lists, polls, wall posts).
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000005a1'), ('bob', '00000000-0000-0000-0000-0000000005b0'),
  ('carol', '00000000-0000-0000-0000-0000000005c0'), ('dave', '00000000-0000-0000-0000-0000000005d0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-social@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'social', repeat('A', 43), repeat('B', 43) from ids;
-- Alice is friends with Bob and Dave; Carol is a stranger.
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'alice' and b.name in ('bob', 'dave');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.friends_aud(n text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = 'friends' $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Reserved usernames
-- ---------------------------------------------------------------------------
select ok(kw.is_reserved_username('Friends'), 'route names are reserved (case-insensitive)');
select ok(not kw.is_reserved_username('alicesocial'), 'normal names are not reserved');
select throws_ok($$ insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000005e0', 'x-social@test.local', 'authenticated', 'authenticated');
                    insert into public.profiles (id, username, sign_pub, kx_pub) values ('00000000-0000-0000-0000-0000000005e0', 'messages', repeat('A', 43), repeat('B', 43)) $$,
  '23514', 'That username is reserved.', 'cannot register a reserved username');
select pg_temp.login('alice');
select throws_ok($$ update public.profiles set username = 'settings' where id = pg_temp.uid('alice') $$,
  '23514', 'That username is reserved.', 'cannot rename to a reserved username');
select lives_ok($$ update public.profiles set discoverable = true, display_name_public = 'Alice' where id = pg_temp.uid('alice') $$,
  'other profile updates are unaffected');

-- ---------------------------------------------------------------------------
-- Link-preview quota
-- ---------------------------------------------------------------------------
select lives_ok($$ select public.link_preview_quota() $$, 'signed-in user may fetch a link preview');
select pg_temp.su();
insert into kw.rate_events (user_id, action) select pg_temp.uid('alice'), 'link_preview' from generate_series(1, 60);
select pg_temp.login('alice');
select throws_ok($$ select public.link_preview_quota() $$, 'P0429', null, 'link previews are rate limited per user');
select pg_temp.login('bob');
select lives_ok($$ select public.link_preview_quota() $$, 'the limit is per user');
select pg_temp.su();
set local role anon;
select throws_ok($$ select public.link_preview_quota() $$, '42501', null, 'anonymous users cannot use the link proxy');
select pg_temp.su();

-- ---------------------------------------------------------------------------
-- Friend lists (custom audiences)
-- ---------------------------------------------------------------------------
select pg_temp.login('alice');
insert into public.audiences (id, owner_id, kind, name_enc)
  values ('20000000-0000-0000-0000-0000000005a1', pg_temp.uid('alice'), 'list', '{"v":1,"b":"x"}');
select lives_ok($$ insert into public.audience_members (audience_id, member_id) values ('20000000-0000-0000-0000-0000000005a1', pg_temp.uid('bob')) $$,
  'owner adds a friend to a list');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005a1', pg_temp.uid('alice'), pg_temp.uid('alice'), 'status',
          '20000000-0000-0000-0000-0000000005a1', 1, '{"v":1}') $$, 'owner posts to a list on her wall');
select is((select count(*)::int from (select 1 from (values (1)) v) x
  where exists (select 1 from public.posts where id = '30000000-0000-0000-0000-0000000005a1')), 1, 'author reads her own post');
select lives_ok($$ with ins as (insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005a3', pg_temp.uid('alice'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') returning id) select * from ins $$,
  'INSERT ... RETURNING works for a new post (insert().select() in the client)');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005a2', pg_temp.uid('alice'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, 'owner posts to her friends');

select pg_temp.login('bob');
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005a1'), 1, 'list member reads the list post');
select is((select count(*)::int from public.audiences where id = '20000000-0000-0000-0000-0000000005a1'), 1, 'list member sees the list audience row');
select throws_ok($$ insert into public.audience_members (audience_id, member_id) values ('20000000-0000-0000-0000-0000000005a1', pg_temp.uid('dave')) $$,
  '42501', null, 'list members cannot add others');

select pg_temp.login('dave');
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005a1'), 0, 'a friend outside the list cannot read the list post');
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005a2'), 1, 'a friend reads friends posts');

select pg_temp.login('carol');
select is((select count(*)::int from public.posts where id in ('30000000-0000-0000-0000-0000000005a1', '30000000-0000-0000-0000-0000000005a2')), 0, 'a stranger reads nothing');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005c1', pg_temp.uid('carol'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, '42501', null, 'a stranger cannot write on a wall');

select pg_temp.login('bob');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005b1', pg_temp.uid('bob'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('alice'), 1, '{"v":1}') $$, 'a friend writes on a wall with the wall owner''s audience');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('30000000-0000-0000-0000-0000000005b2', pg_temp.uid('bob'), pg_temp.uid('alice'), 'status',
          pg_temp.friends_aud('bob'), 1, '{"v":1}') $$, '42501', null, 'wall posts must use the wall owner''s audience');

-- Removing Bob from the list (and rotating) revokes access.
select pg_temp.login('alice');
select lives_ok($$ delete from public.audience_members where audience_id = '20000000-0000-0000-0000-0000000005a1' and member_id = pg_temp.uid('bob') $$,
  'owner removes a list member');
select lives_ok($$ update public.audiences set current_epoch = 2 where id = '20000000-0000-0000-0000-0000000005a1' $$, 'owner rotates the list key');
select pg_temp.login('bob');
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005a1'), 0, 'a removed member can no longer read list posts');

-- Wall owner can delete posts on their wall; others cannot.
select pg_temp.login('dave');
delete from public.posts where id = '30000000-0000-0000-0000-0000000005b1';
select pg_temp.su();
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005b1'), 1, 'other friends cannot delete wall posts');
select pg_temp.login('alice');
delete from public.posts where id = '30000000-0000-0000-0000-0000000005b1';
select pg_temp.su();
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005b1'), 0, 'wall owner deletes a post on her wall');

-- Unfriending removes read access to the friends audience.
select pg_temp.login('alice');
delete from public.friendships where user_a = least(pg_temp.uid('alice'), pg_temp.uid('dave')) and user_b = greatest(pg_temp.uid('alice'), pg_temp.uid('dave'));
select pg_temp.login('dave');
select is((select count(*)::int from public.posts where id = '30000000-0000-0000-0000-0000000005a2'), 0, 'an ex-friend can no longer fetch friends posts');

select * from finish();
rollback;
