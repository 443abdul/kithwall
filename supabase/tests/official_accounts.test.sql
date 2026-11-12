-- Official, automated accounts (migration 20261113000100_official_accounts.sql, docs/v2/13-official-accounts.md).
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('bot', '00000000-0000-0000-0000-00000000f0a1'),   -- becomes an official account
  ('ann', '00000000-0000-0000-0000-00000000f0b1'),   -- an ordinary person, account three days old
  ('new', '00000000-0000-0000-0000-00000000f0c1'),   -- an ordinary person who joined a minute ago
  ('adm', '00000000-0000-0000-0000-00000000f0d1'),   -- an admin
  ('imp', '00000000-0000-0000-0000-00000000f0e1');   -- tries to take a "kithwall" handle
grant select on ids to authenticated, anon;

insert into auth.users (id, email, aud, role)
  select id, name || '-official@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub, created_at)
  select id, name || 'ofqx', repeat('A', 43), repeat('B', 43), case when name = 'new' then now() else now() - interval '3 days' end
    from ids where name in ('ann', 'new', 'adm');
insert into public.staff_roles (user_id, role) select id, 'admin' from ids where name = 'adm';
update public.app_settings set value = 'true'::jsonb where key in ('public_posts_enabled', 'official_accounts_enabled');
update public.app_settings set value = '24'::jsonb where key = 'public_post_min_age_hours';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end $$;
create function pg_temp.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;
create function pg_temp.bundle() returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'signPub', repeat('C', 43), 'kxPub', repeat('D', 43), 'amkByRecovery', 'r',
                            'identityEnc', 'i', 'rkCommitment', 'c', 'amkByPassword', 'w') $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- ---------------------------------------------------------------------------
-- The handle prefix belongs to Kithwall
-- ---------------------------------------------------------------------------
select pg_temp.su();
select throws_ok(
  $$ insert into public.profiles (id, username, sign_pub, kx_pub) values (pg_temp.uid('imp'), 'kithwall.fake', repeat('A', 43), repeat('B', 43)) $$,
  '23514', null, 'nobody registers a handle that starts with "kithwall"');
select throws_ok(
  $$ update public.profiles set username = 'kithwallnews' where id = pg_temp.uid('ann') $$,
  '23514', null, 'nor renames an account to one');

-- ---------------------------------------------------------------------------
-- Creating an official account
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select throws_ok(
  $$ select public.create_official_account(pg_temp.uid('bot'), 'tapbot', 'kithwall.tapqx', 'Kithwall Learn', pg_temp.bundle()) $$,
  '42501', null, 'a person cannot create an official account');
select pg_temp.su();
select throws_ok(
  $$ select public.create_official_account(pg_temp.uid('bot'), 'tapbot', 'tapqx.kithwall', 'Kithwall Learn', pg_temp.bundle()) $$,
  '22023', null, 'official handles start with "kithwall."');
select throws_ok(
  $$ select public.create_official_account(pg_temp.uid('bot'), 'tapbot', 'kithwall.tapqx', 'Kithwall Learn', pg_temp.bundle() - 'amkByPassword') $$,
  '22023', null, 'an official account needs keys the job can open');
select lives_ok(
  $$ select public.create_official_account(pg_temp.uid('bot'), 'tapbot', 'kithwall.tapqx', 'Kithwall Learn', pg_temp.bundle()) $$,
  'the service role creates it');
select results_eq(
  $$ select username::text, display_name_public, follow_enabled from public.profiles where id = pg_temp.uid('bot') $$,
  $$ values ('kithwall.tapqx', 'Kithwall Learn', true) $$, 'it has its handle and public name and can be followed');
select is((select count(*) from public.audiences where owner_id = pg_temp.uid('bot') and kind = 'followers'), 1::bigint,
  'it has a followers audience like every followable account');
select results_eq(
  $$ select mention_policy, requests_from, index_public from public.privacy_prefs where user_id = pg_temp.uid('bot') $$,
  $$ values ('nobody', 'nobody', true) $$, 'it cannot be mentioned or sent requests; search engines may show its posts');

-- ---------------------------------------------------------------------------
-- The badge list is public; the tables are not
-- ---------------------------------------------------------------------------
select pg_temp.anon();
select results_eq(
  $$ select username, display_name from public.automated_accounts() where id = pg_temp.uid('bot') $$,
  $$ values ('kithwall.tapqx', 'Kithwall Learn') $$, 'anyone can tell which accounts are automated');
select is((select count(*) from public.official_accounts), 0::bigint, 'the table itself shows nothing to visitors');
select pg_temp.login('ann');
select is((select count(*) from public.official_accounts), 0::bigint, 'and shows nothing to people');
select is((select count(*) from public.official_items), 0::bigint, 'the posted-items list shows nothing to people');
select is((select count(*) from public.official_sources), 0::bigint, 'the sources are for staff');
select pg_temp.login('adm');
select cmp_ok((select count(*) from public.official_sources), '>=', 10::bigint, 'staff see the sources');

-- ---------------------------------------------------------------------------
-- Posting publicly, and connections
-- ---------------------------------------------------------------------------
select pg_temp.su();
update public.profiles set display_name_public = 'New Person', follow_enabled = true where id = pg_temp.uid('new');
select is(kw.may_post_public(pg_temp.uid('new')), false, 'a new ordinary account still waits before posting publicly');
select is(kw.may_post_public(pg_temp.uid('bot')), true, 'an official account posts publicly from its first minute');
update public.app_settings set value = 'false'::jsonb where key = 'public_posts_enabled';
select is(kw.may_post_public(pg_temp.uid('bot')), false, 'but not while the operator has public posts switched off');
update public.app_settings set value = 'true'::jsonb where key = 'public_posts_enabled';

select pg_temp.login('ann');
select throws_ok(
  $$ insert into public.friendships (user_a, user_b, requested_by)
     values (least(pg_temp.uid('ann'), pg_temp.uid('bot')), greatest(pg_temp.uid('ann'), pg_temp.uid('bot')), pg_temp.uid('ann')) $$,
  '42501', null, 'an automated account cannot be sent a connection request');
select lives_ok(
  $$ insert into public.follows (follower_id, followee_id) values (pg_temp.uid('ann'), pg_temp.uid('bot')) $$,
  'it can be followed');

-- ---------------------------------------------------------------------------
-- Preview pictures (20261113000400_official_previews.sql): a post that went out without its picture gets it
-- later. The account links the stored picture to its post, then edits the post to name it.
-- ---------------------------------------------------------------------------
select pg_temp.login('bot');
select lives_ok(
  $$ insert into public.posts (id, author_id, wall_owner_id, kind, is_public, envelope)
     values ('00000000-0000-0000-0000-0000000f1001', pg_temp.uid('bot'), pg_temp.uid('bot'), 'link', true,
             '{"v":1,"sig":"x","body":{"text":"A headline","link":{"url":"https://example.org/a"}}}') $$,
  'the account posts a link publicly');
select lives_ok(
  $$ insert into public.media_objects (path, owner_id, bytes)
     values (pg_temp.uid('bot') || '/00000000-0000-0000-0000-0000000f2001', pg_temp.uid('bot'), 1000) $$,
  'it stores a picture in its own folder');
select pg_temp.anon();
select is(public.public_media_readable(pg_temp.uid('bot') || '/00000000-0000-0000-0000-0000000f2001'), false,
  'a picture that belongs to no post is not served to visitors');
select pg_temp.login('bot');
select lives_ok(
  $$ update public.media_objects set post_id = '00000000-0000-0000-0000-0000000f1001'
      where path = pg_temp.uid('bot') || '/00000000-0000-0000-0000-0000000f2001' $$,
  'it links the picture to the post');
select lives_ok(
  $$ update public.posts set envelope = '{"v":1,"sig":"y","body":{"text":"A headline","link":{"url":"https://example.org/a","image":{"path":"p"}}}}'
      where id = '00000000-0000-0000-0000-0000000f1001' $$,
  'and edits its own post to show it');
select isnt((select edited_at from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), null, 'the post is marked as edited');
select pg_temp.anon();
select is(public.public_media_readable(pg_temp.uid('bot') || '/00000000-0000-0000-0000-0000000f2001'), true,
  'visitors can now fetch the picture of the public post');
select pg_temp.login('ann');
update public.posts set envelope = '{"v":1,"sig":"z","body":{}}' where id = '00000000-0000-0000-0000-0000000f1001';
select is((select envelope->>'sig' from public.posts where id = '00000000-0000-0000-0000-0000000f1001'), 'y',
  'nobody else can edit the account''s post');

-- ---------------------------------------------------------------------------
-- Sources: switched by admins only, never re-pointed
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select throws_ok($$ select public.set_official_source('bbc-world', true) $$, '42501', null, 'a person cannot switch a source');
select pg_temp.login('adm');
select lives_ok($$ select public.set_official_source('bbc-world', true) $$, 'an admin can');
select is((select enabled from public.official_sources where id = 'bbc-world'), true, 'and it is on');
select throws_ok($$ select public.set_official_source('no-such-source', true) $$, 'P0002', null, 'unknown sources are refused');
update public.official_sources set url = 'https://evil.example/feed' where id = 'bbc-world';
select is((select url from public.official_sources where id = 'bbc-world'), 'https://feeds.bbci.co.uk/news/world/rss.xml',
  'an admin cannot point a source somewhere else');
select throws_ok($$ update public.app_settings set value = '"yes"'::jsonb where key = 'official_accounts_enabled' $$,
  '22023', null, 'the switch is true or false');

-- ---------------------------------------------------------------------------
-- The Admin screen (20261113000300_official_admin.sql): accounts and sources an admin adds
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select throws_ok($$ select public.add_official_account('kithwall.tapnews', 'Tap News') $$, '42501', null, 'a person cannot add an automated account');
select throws_ok($$ select public.set_official_source_rate('nasa-iotd', 6) $$, '42501', null, 'nor change how often a source posts');
select throws_ok($$ select public.remove_official_source('nasa-iotd') $$, '42501', null, 'nor remove a source');
select pg_temp.login('adm');
select is(public.add_official_account('@Kithwall.TapNews', '  Tap News  '), 'tapnews', 'an admin adds an account (handle tidied)');
select results_eq($$ select handle, name, custom from public.official_account_defs where slug = 'tapnews' $$,
  $$ values ('kithwall.tapnews', 'Tap News', true) $$, 'with its handle and name, marked as added by an admin');
select throws_ok($$ select public.add_official_account('tapnews', 'Tap News') $$, '22023', null, 'the handle must start with kithwall.');
select throws_ok($$ select public.add_official_account('kithwall.tap-news', 'Tap News') $$, '22023', null, 'and be letters only');
select throws_ok($$ select public.add_official_account('kithwall.tapother', 'x') $$, '22023', null, 'the name cannot be one letter');
select throws_ok($$ select public.add_official_account('kithwall.tapnews', 'Again') $$, '23505', null, 'the same account twice is refused');
select lives_ok($$ select public.set_official_source_rate('nasa-iotd', 6) $$, 'an admin sets how many posts a day a source makes');
select is((select per_day from public.official_sources where id = 'nasa-iotd'), 6, 'and it is stored');
select throws_ok($$ select public.set_official_source_rate('nasa-iotd', 25) $$, '22023', null, 'at most 24 a day');
select throws_ok($$ select public.set_official_source_rate('nasa-iotd', 0) $$, '22023', null, 'at least 1');
select throws_ok($$ select public.remove_official_source('nasa-iotd') $$, 'P0002', null, 'a built-in source cannot be removed, only switched off');
select throws_ok($$ select public.remove_official_account('learn') $$, '22023', null, 'an account that has sources or has posted cannot be removed');
select pg_temp.su();
select throws_ok(
  $$ insert into public.official_sources (id, account, kind, title, url, terms, custom) values ('tap-pic', 'tapnews', 'nasa-image', 'Tap pictures', 'https://example.org/f', 'public-domain', true) $$,
  '23514', null, 'a source an admin added never shows more than the headline or the feed''s summary');
select throws_ok(
  $$ insert into public.official_sources (id, account, kind, title, url, terms, custom) values ('tap-orphan', 'nosuch', 'rss', 'Tap orphan', 'https://example.org/f', 'headline', true) $$,
  '23503', null, 'a source belongs to an account that exists');
insert into public.official_sources (id, account, kind, title, url, terms, custom) values ('tap-custom', 'tapnews', 'rss', 'Tap feed', 'https://example.org/feed', 'headline', true);
select pg_temp.login('adm');
select throws_ok($$ select public.remove_official_account('tapnews') $$, '22023', null, 'an account with sources is not removed');
select lives_ok($$ select public.remove_official_source('tap-custom') $$, 'an admin removes a source they added');
select lives_ok($$ select public.remove_official_account('tapnews') $$, 'and then the unused account');
select throws_ok($$ select public.remove_official_account('tapbot') $$, '22023', null, 'an account that exists as a profile is not removed here');

-- An automated account may post publicly far more often than a person (the sources' own limits hold it).
select pg_temp.su();
select is((select prosrc like '%when kw.is_official(auth.uid()) then 300 else 20 end%' from pg_proc where proname = 'posts_guard' and pronamespace = 'kw'::regnamespace),
  true, 'the public-post limit is 300 a day for automated accounts and 20 for people');

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
select pg_temp.su();
insert into public.official_sources (id, account, kind, title, url, terms) values
  ('tap-source', 'learn', 'rss', 'Test source', 'https://example.org/feed', 'headline');
insert into public.official_items (source_id, item_key, created_at) values
  ('tap-source', repeat('a', 43), now() - interval '500 days'), ('tap-source', repeat('b', 43), now());
select results_eq($$ select has_picture, picture_tries::int from public.official_items where source_id = 'tap-source' and item_key = repeat('b', 43) $$,
  $$ values (false, 0) $$, 'a posted item starts without its picture and with no attempt made');
select throws_ok($$ update public.official_items set picture_tries = -1 where source_id = 'tap-source' $$, '23514', null, 'attempts are counted from zero');
select public.official_housekeeping();
select results_eq($$ select item_key from public.official_items where source_id = 'tap-source' $$, array[repeat('b', 43)],
  'items older than 400 days are forgotten');

select * from finish();
rollback;
