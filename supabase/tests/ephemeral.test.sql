-- Disappearing, scheduled, edit and unsend (20261024000100_ephemeral.sql): server-computed expiry, timer
-- permissions and notices, invisibility of expired and scheduled content, the clock job, edit permissions,
-- unsend tombstones and the media trash. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann & Ben are connected; Cal is in a group chat with them; Dee is a stranger.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-0000000e0a10'), ('ben', '00000000-0000-0000-0000-0000000e0b20'),
  ('cal', '00000000-0000-0000-0000-0000000e0c30'), ('dee', '00000000-0000-0000-0000-0000000e0d40');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-eph@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'ephem', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where (a.name, b.name) in (('ann', 'ben'));

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

-- A DM (Ann–Ben, created as a NEW conversation, so it gets the default timer), a group chat owned by Ann
-- (Ben member, Cal member), and an "old" DM Ann–Cal whose timer is off (as after the migration).
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values
  ('e0000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'conversation'),
  ('e0000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'conversation'),
  ('e0000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('e0000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'admin', 'active'),
  ('e0000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 'member', 'active'),
  ('e0000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'admin', 'active'),
  ('e0000000-0000-0000-0000-000000000002', pg_temp.uid('ben'), 'member', 'active'),
  ('e0000000-0000-0000-0000-000000000002', pg_temp.uid('cal'), 'member', 'active'),
  ('e0000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'admin', 'active'),
  ('e0000000-0000-0000-0000-000000000003', pg_temp.uid('cal'), 'member', 'active');

select pg_temp.login('ann');
select lives_ok($$ insert into public.conversations (id, audience_id, created_by, dm_key)
  values ('e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', pg_temp.uid('ann'),
          least(pg_temp.uid('ann'), pg_temp.uid('ben'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('ben'))::text) $$,
  'Ann starts a DM with Ben');
select is((select disappear_secs from public.conversations where id = 'e1000000-0000-0000-0000-000000000001'), 2419200,
  'new conversations disappear after 4 weeks by default');
insert into public.conversations (id, audience_id, created_by)
  values ('e1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', pg_temp.uid('ann'));
select pg_temp.su();
insert into public.conversations (id, audience_id, created_by, dm_key, disappear_secs)
  values ('e1000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003', pg_temp.uid('ann'),
          least(pg_temp.uid('ann'), pg_temp.uid('cal'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('cal'))::text, null);

-- ---------------------------------------------------------------------------------------------
-- 1. Expiry is computed by the server at insert
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ben');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope, expires_at)
  values ('e2000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 1, '{"c":"hi"}',
          now() + interval '50 years') $$, 'Ben sends a message (asking for a 50-year lifetime)');
select ok((select expires_at between now() + interval '27 days 23 hours' and now() + interval '28 days 1 hour'
             from public.messages where id = 'e2000000-0000-0000-0000-000000000001'),
  'expires_at comes from the conversation timer, not the client');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope, notice)
  values ('e2000000-0000-0000-0000-000000000009', 'e1000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 1, '{}',
          '{"kind":"timer","secs":null}') $$, '42501', null, 'clients cannot forge server notices');

select pg_temp.login('ann');
insert into public.messages (id, conversation_id, sender_id, epoch, envelope, expires_at)
  values ('e2000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 1, '{"c":"old"}', now() + interval '1 day');
select is((select expires_at from public.messages where id = 'e2000000-0000-0000-0000-000000000003'), null,
  'with the timer off, messages do not expire (and a client value is ignored)');

-- ---------------------------------------------------------------------------------------------
-- 2. Changing the timer: who may, and the notice everyone sees
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ben');
select lives_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000001', 86400) $$,
  'any member of a 1:1 chat changes its timer');
select is((select disappear_secs from public.conversations where id = 'e1000000-0000-0000-0000-000000000001'), 86400, 'the timer is stored');
select ok((select disappear_set_at is not null from public.conversations where id = 'e1000000-0000-0000-0000-000000000001'), 'and when it was chosen');
select is((select notice from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null),
  '{"kind":"timer","secs":86400}'::jsonb, 'a server notice records the change in the thread');
select is((select sender_id from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null),
  pg_temp.uid('ben'), 'the notice names who changed it');
select pg_temp.login('ann');
select is((select count(*)::int from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null), 1,
  'the other member sees the notice');
select lives_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000001', 86400) $$, 'setting the same value again…');
select is((select count(*)::int from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null), 1,
  '…adds no second notice');
select throws_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000001', 12345) $$, '22023', null,
  'only the offered timers are accepted');

-- Group chats: only admins (the owner here). Cal is a plain member.
select lives_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000002', null) $$,
  'a group admin turns disappearing messages off');
select is((select disappear_secs from public.conversations where id = 'e1000000-0000-0000-0000-000000000002'), null, 'off is stored as null');
select is((select notice from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000002' and notice is not null),
  '{"kind":"timer","secs":null}'::jsonb, 'turning it off is announced too');
select pg_temp.login('cal');
select throws_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000002', 604800) $$, '42501', null,
  'members who are not admins cannot change a group chat''s timer');
select pg_temp.login('dee');
select throws_ok($$ select public.set_conversation_timer('e1000000-0000-0000-0000-000000000001', 604800) $$, '42501', null,
  'strangers cannot change a chat''s timer');
select is((select count(*)::int from public.conversations), 0, 'strangers do not even see the chats');
-- There is no UPDATE policy on conversations: the RPC is the only way.
select pg_temp.login('ben');
update public.conversations set disappear_secs = 7776000 where id = 'e1000000-0000-0000-0000-000000000001';
select is((select disappear_secs from public.conversations where id = 'e1000000-0000-0000-0000-000000000001'), 86400,
  'the timer cannot be changed by a direct update');

-- ---------------------------------------------------------------------------------------------
-- 3. Expired messages are invisible at once and removed by the clock
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
insert into public.media_objects (path, owner_id, message_id, bytes)
  values ('00000000-0000-0000-0000-0000000e0b20/e3000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 'e2000000-0000-0000-0000-000000000001', 10);
select set_config('kw.trusted_write', 'on', true);
update public.messages set expires_at = now() - interval '1 second' where id = 'e2000000-0000-0000-0000-000000000001';
select set_config('kw.trusted_write', 'off', true);
select pg_temp.login('ann');
select is((select count(*)::int from public.messages where id = 'e2000000-0000-0000-0000-000000000001'), 0,
  'an expired message is hidden from members before the clock runs');
select is((select count(*)::int from public.conversation_previews(array['e1000000-0000-0000-0000-000000000001'::uuid]) p
            where p.id = 'e2000000-0000-0000-0000-000000000001'), 0, 'and from the conversation list preview');
select ok(not kw.can_read_media('00000000-0000-0000-0000-0000000e0b20/e3000000-0000-0000-0000-000000000001'),
  'its files are no longer readable by the other member');
select pg_temp.su();
select lives_ok($$ select kw.ephemeral_tick() $$, 'the clock runs');
select is((select count(*)::int from public.messages where id = 'e2000000-0000-0000-0000-000000000001'), 0, 'the expired row is deleted');
select is((select count(*)::int from public.media_objects where message_id = 'e2000000-0000-0000-0000-000000000001'), 0, 'with its media rows');
select is((select count(*)::int from kw.media_trash where path = '00000000-0000-0000-0000-0000000e0b20/e3000000-0000-0000-0000-000000000001'), 1,
  'the storage path waits in the trash for the web cron');
select is((select count(*)::int from public.trashed_media(1000) t where t = '00000000-0000-0000-0000-0000000e0b20/e3000000-0000-0000-0000-000000000001'), 1,
  'trashed_media() lists it');
select is(public.forget_trashed_media(array['00000000-0000-0000-0000-0000000e0b20/e3000000-0000-0000-0000-000000000001']), 1,
  'forget_trashed_media() clears it after the objects are removed');
select pg_temp.login('ann');
select throws_ok($$ select public.trashed_media(10) $$, '42501', null, 'signed-in users cannot list the trash');
select is((select count(*)::int from public.messages where id = 'e2000000-0000-0000-0000-000000000003'), 1,
  'messages in a chat with the timer off are kept');

-- ---------------------------------------------------------------------------------------------
-- 4. Editing messages
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('e2000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 1, '{"c":"v1"}');
select lives_ok($$ update public.messages set envelope = '{"c":"v2"}' where id = 'e2000000-0000-0000-0000-000000000004' $$,
  'the sender edits a message (new sealed payload)');
select is((select envelope->>'c' from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), 'v2', 'the old payload is replaced');
select ok((select edited_at is not null from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), 'edited_at is set by the server');
select throws_ok($$ update public.messages set epoch = 2 where id = 'e2000000-0000-0000-0000-000000000004' $$,
  'P0001', null, 'an edit cannot move a message to another epoch');
select throws_ok($$ update public.messages set expires_at = now() + interval '1 day' where id = 'e2000000-0000-0000-0000-000000000004' $$,
  'P0001', null, 'an edit cannot change when a message disappears');
select pg_temp.login('ben');
update public.messages set envelope = '{"c":"hacked"}' where id = 'e2000000-0000-0000-0000-000000000004';
select is((select envelope->>'c' from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), 'v2',
  'other members cannot edit someone else''s message');
update public.messages set envelope = '{"c":"x"}' where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null;
select is((select envelope from public.messages where conversation_id = 'e1000000-0000-0000-0000-000000000001' and notice is not null),
  '{}'::jsonb, 'server notices cannot be edited, even by the person who triggered them');

-- ---------------------------------------------------------------------------------------------
-- 5. Unsend: the ciphertext is wiped at once; a tombstone tells the others; the clock removes it
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ben');
select throws_ok($$ select public.unsend_message('e2000000-0000-0000-0000-000000000004') $$, '42501', null,
  'only the sender can unsend');
select pg_temp.login('ann');
select lives_ok($$ select public.unsend_message('e2000000-0000-0000-0000-000000000004') $$, 'the sender unsends');
select is((select envelope from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), '{}'::jsonb, 'the ciphertext is gone');
select ok((select unsent_at is not null from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), 'a tombstone remains for now');
update public.messages set envelope = '{"c":"back"}' where id = 'e2000000-0000-0000-0000-000000000004';
select is((select envelope from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), '{}'::jsonb,
  'an unsent message cannot be edited back');
select is((select count(*)::int from public.conversation_previews(array['e1000000-0000-0000-0000-000000000002'::uuid]) p
            where p.id = 'e2000000-0000-0000-0000-000000000004'), 0, 'tombstones never show as a chat preview');
select pg_temp.su();
select set_config('kw.trusted_write', 'on', true);
update public.messages set unsent_at = now() - interval '11 minutes' where id = 'e2000000-0000-0000-0000-000000000004';
select set_config('kw.trusted_write', 'off', true);
select kw.ephemeral_tick();
select is((select count(*)::int from public.messages where id = 'e2000000-0000-0000-0000-000000000004'), 0, 'the clock removes old tombstones');

-- ---------------------------------------------------------------------------------------------
-- 6. Disappearing posts
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, disappear_secs, expires_at)
  values ('e4000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', pg_temp.friends('ann'), 1, '{"v":1}',
          86400, now() + interval '9 years') $$, 'Ann posts with a 1-day timer');
select ok((select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
             from public.posts where id = 'e4000000-0000-0000-0000-000000000001'), 'the post expiry is computed by the server');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, disappear_secs)
  values ('e4000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', pg_temp.friends('ann'), 1, '{"v":1}', 3) $$,
  '23514', null, 'only the offered post timers are accepted');
select pg_temp.login('ben');
select lives_ok($$ insert into public.comments (id, post_id, author_id, envelope)
  values ('e5000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), '{"v":1}') $$, 'Ben comments');
select lives_ok($$ insert into public.likes (target_kind, target_id, user_id) values ('post', 'e4000000-0000-0000-0000-000000000001', pg_temp.uid('ben')) $$, 'Ben likes it');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'like', 'post', 'e4000000-0000-0000-0000-000000000001') $$, 'and notifies Ann');
select pg_temp.su();
alter table public.posts disable trigger posts_guard;
update public.posts set expires_at = now() - interval '1 second' where id = 'e4000000-0000-0000-0000-000000000001';
alter table public.posts enable trigger posts_guard;
select pg_temp.login('ben');
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000001'), 0, 'an expired post is hidden at once');
select is((select count(*)::int from public.comments where post_id = 'e4000000-0000-0000-0000-000000000001'), 0, 'and so are its comments');
select pg_temp.login('ann');
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000001'), 0, 'even from its author');
select pg_temp.su();
select kw.ephemeral_tick();
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000001'), 0, 'the clock deletes the post');
select is((select count(*)::int from public.comments where id = 'e5000000-0000-0000-0000-000000000001'), 0, 'with its comments');
select is((select count(*)::int from public.likes where target_id = 'e4000000-0000-0000-0000-000000000001'), 0, 'its likes');
select is((select count(*)::int from public.notifications where object_id = 'e4000000-0000-0000-0000-000000000001'), 0, 'and notifications about it');

-- ---------------------------------------------------------------------------------------------
-- 7. Scheduled posts
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, publish_at, disappear_secs)
  values ('e4000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', pg_temp.friends('ann'), 1, '{"v":1}',
          now() + interval '2 hours', 604800) $$, 'Ann schedules a post for two hours from now');
select ok((select created_at = publish_at from public.posts where id = 'e4000000-0000-0000-0000-000000000003'),
  'a scheduled post takes its place in the feed at its publish time');
select ok((select expires_at = publish_at + interval '7 days' from public.posts where id = 'e4000000-0000-0000-0000-000000000003'),
  'its timer starts when it goes out');
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000003'), 1, 'the author sees her scheduled post');
select is((select count(*)::int from public.feed_posts() where id = 'e4000000-0000-0000-0000-000000000003'), 0,
  'but it stays out of her home feed until it goes out');
select throws_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, publish_at)
  values ('e4000000-0000-0000-0000-000000000004', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', pg_temp.friends('ann'), 1, '{"v":1}',
          now() + interval '2 years') $$, '22023', null, 'posts can be scheduled at most a year ahead');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, publish_at)
  values ('e4000000-0000-0000-0000-000000000005', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', pg_temp.friends('ann'), 1, '{"v":1}',
          now() - interval '1 hour') $$, 'a publish time in the past…');
select is((select publish_at from public.posts where id = 'e4000000-0000-0000-0000-000000000005'), null, '…just posts now');

select pg_temp.login('ben');
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000003'), 0,
  'connections cannot see a scheduled post before its time');
select is((select count(*)::int from public.feed_posts() where id = 'e4000000-0000-0000-0000-000000000003'), 0, 'not in their feed either');
select ok(not kw.can_read_post('e4000000-0000-0000-0000-000000000003'), 'kw.can_read_post says no');
select throws_ok($$ insert into public.comments (id, post_id, author_id, envelope)
  values ('e5000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000003', pg_temp.uid('ben'), '{"v":1}') $$,
  '42501', null, 'nobody can comment on it yet');
select throws_ok($$ insert into public.likes (target_kind, target_id, user_id) values ('post', 'e4000000-0000-0000-0000-000000000003', pg_temp.uid('ben')) $$,
  '42501', null, 'or like it');

-- The author can edit, reschedule and publish now.
select pg_temp.login('ann');
select lives_ok($$ update public.posts set envelope = '{"v":2}' where id = 'e4000000-0000-0000-0000-000000000003' $$, 'the author edits a scheduled post');
select is((select edited_at from public.posts where id = 'e4000000-0000-0000-0000-000000000003'), null, 'nobody has seen it yet, so it is not "edited"');
select lives_ok($$ update public.posts set publish_at = now() + interval '3 hours' where id = 'e4000000-0000-0000-0000-000000000003' $$, 'and reschedules it');
select ok((select created_at = publish_at and created_at > now() + interval '2 hours 59 minutes' from public.posts where id = 'e4000000-0000-0000-0000-000000000003'),
  'rescheduling moves its feed time');

-- Time passes: bring the publish time forward (as the database owner) and run the clock.
select pg_temp.su();
alter table public.posts disable trigger posts_guard;
update public.posts set publish_at = now() - interval '1 second', created_at = now() - interval '1 second'
 where id = 'e4000000-0000-0000-0000-000000000003';
alter table public.posts enable trigger posts_guard;
select pg_temp.login('ben');
select is((select count(*)::int from public.posts where id = 'e4000000-0000-0000-0000-000000000003'), 1,
  'at its publish time it is visible at once, before the clock runs');
select pg_temp.su();
select kw.ephemeral_tick();
select is((select publish_at from public.posts where id = 'e4000000-0000-0000-0000-000000000003'), null, 'the clock marks it published');
select is((select count(*)::int from public.notifications where object_id = 'e4000000-0000-0000-0000-000000000003' and type = 'post_published'
             and recipient_id = pg_temp.uid('ann')), 1, 'and notifies the author (which fires the push) at publish time');
select kw.ephemeral_tick();
select is((select count(*)::int from public.notifications where object_id = 'e4000000-0000-0000-0000-000000000003' and type = 'post_published'), 1,
  'only once');
select pg_temp.login('ann');
select throws_ok($$ update public.posts set publish_at = now() + interval '1 day' where id = 'e4000000-0000-0000-0000-000000000003' $$,
  'P0001', null, 'a published post cannot be scheduled again');

-- ---------------------------------------------------------------------------------------------
-- 8. Comment edits
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ben');
insert into public.comments (id, post_id, author_id, envelope)
  values ('e5000000-0000-0000-0000-000000000003', 'e4000000-0000-0000-0000-000000000003', pg_temp.uid('ben'), '{"v":1}');
select lives_ok($$ update public.comments set envelope = '{"v":2}' where id = 'e5000000-0000-0000-0000-000000000003' $$, 'the author edits a comment');
select ok((select edited_at is not null and envelope->>'v' = '2' from public.comments where id = 'e5000000-0000-0000-0000-000000000003'),
  'the comment is replaced and marked edited');
select throws_ok($$ update public.comments set post_id = 'e4000000-0000-0000-0000-000000000005' where id = 'e5000000-0000-0000-0000-000000000003' $$,
  'P0001', null, 'a comment cannot move to another post');
select pg_temp.login('ann');
update public.comments set envelope = '{"v":9}' where id = 'e5000000-0000-0000-0000-000000000003';
select is((select envelope->>'v' from public.comments where id = 'e5000000-0000-0000-0000-000000000003'), '2',
  'the post author cannot edit someone else''s comment');
select lives_ok($$ delete from public.comments where id = 'e5000000-0000-0000-0000-000000000003' $$, 'but can delete it');

select * from finish();
rollback;
