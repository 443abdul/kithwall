-- Kithwall 2 messages (migration 20261022000500): private read markers + reciprocal read receipts,
-- connection-request privacy, encrypted reactions, circle chats. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann & Ben are connected; Cal is connected to Ben only; Dee is a stranger.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-0000000005a1'), ('ben', '00000000-0000-0000-0000-0000000005b0'),
  ('cal', '00000000-0000-0000-0000-0000000005c0'), ('dee', '00000000-0000-0000-0000-0000000005d0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-m2@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'mtwo', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where (a.name, b.name) in (('ann', 'ben'), ('ben', 'cal'));

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A DM between Ann and Ben, with one message from Ben.
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values ('50000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status)
  values ('50000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'admin', 'active'),
         ('50000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 'member', 'active');
insert into public.conversations (id, audience_id, created_by, dm_key)
  values ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', pg_temp.uid('ann'),
          least(pg_temp.uid('ann'), pg_temp.uid('ben'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('ben'))::text);
insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 1, '{}');

-- ---------------------------------------------------------------------------------------
-- 1. Read markers are private
-- ---------------------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.conversation_reads (conversation_id, user_id) values ('51000000-0000-0000-0000-000000000001', pg_temp.uid('ann')) $$,
  'a member sets their read marker');
select throws_ok($$ insert into public.conversation_reads (conversation_id, user_id) values ('51000000-0000-0000-0000-000000000001', pg_temp.uid('ben')) $$,
  '42501', null, 'nobody sets someone else''s read marker');
select pg_temp.login('dee');
select throws_ok($$ insert into public.conversation_reads (conversation_id, user_id) values ('51000000-0000-0000-0000-000000000001', pg_temp.uid('dee')) $$,
  '42501', null, 'non-members cannot keep a read marker');

select pg_temp.login('ben');
insert into public.conversation_reads (conversation_id, user_id) values ('51000000-0000-0000-0000-000000000001', pg_temp.uid('ben'));
select is((select count(*)::int from public.conversation_reads), 1, 'members only see their own read markers');

-- Markers only move forward and never into the future.
update public.conversation_reads set last_read_at = now() - interval '1 day' where user_id = pg_temp.uid('ben');
select ok((select last_read_at > now() - interval '1 minute' from public.conversation_reads where user_id = pg_temp.uid('ben')), 'read markers never move back');
update public.conversation_reads set last_read_at = now() + interval '1 day' where user_id = pg_temp.uid('ben');
select ok((select last_read_at <= now() from public.conversation_reads where user_id = pg_temp.uid('ben')), 'read markers never point into the future');

-- The old shared column is no longer filled for conversations.
update public.audience_members set last_read_at = now()
 where audience_id = '50000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ben');
select pg_temp.login('ann');
select is((select last_read_at from public.audience_members
            where audience_id = '50000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ben')), null,
  'co-members no longer see audience_members.last_read_at for conversations');

-- ---------------------------------------------------------------------------------------
-- 2. Read receipts are off by default and reciprocal
-- ---------------------------------------------------------------------------------------
select is((select count(*)::int from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), 0,
  'no receipts while both have them off (default)');
insert into public.privacy_prefs (user_id, read_receipts) values (pg_temp.uid('ann'), true);
select is((select count(*)::int from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), 0,
  'turning mine on does not reveal someone who keeps theirs off');
select pg_temp.login('ben');
select is((select count(*)::int from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), 0,
  'someone with receipts off sees nobody''s receipts');
insert into public.privacy_prefs (user_id, read_receipts) values (pg_temp.uid('ben'), true);
select is((select count(*)::int from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), 1,
  'both on: Ben sees when Ann read');
select pg_temp.login('ann');
select is((select user_id from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), pg_temp.uid('ben'),
  'both on: Ann sees when Ben read');
select pg_temp.login('dee');
insert into public.privacy_prefs (user_id, read_receipts) values (pg_temp.uid('dee'), true);
select is((select count(*)::int from public.conversation_receipts('51000000-0000-0000-0000-000000000001')), 0,
  'non-members get no receipts');
select is((select count(*)::int from public.privacy_prefs), 1, 'privacy prefs are owner-only');

-- ---------------------------------------------------------------------------------------
-- 3. Who may send connection requests
-- ---------------------------------------------------------------------------------------
select pg_temp.login('ann');
insert into public.privacy_prefs (user_id, requests_from) values (pg_temp.uid('ann'), 'everyone')
  on conflict (user_id) do update set requests_from = 'nobody';
select pg_temp.login('dee');
select throws_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('dee'), pg_temp.uid('ann')), greatest(pg_temp.uid('dee'), pg_temp.uid('ann')), pg_temp.uid('dee')) $$,
  '42501', null, '"nobody": requests are refused');
select pg_temp.login('ann');
update public.privacy_prefs set requests_from = 'mutual' where user_id = pg_temp.uid('ann');
select pg_temp.login('dee');
select throws_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('dee'), pg_temp.uid('ann')), greatest(pg_temp.uid('dee'), pg_temp.uid('ann')), pg_temp.uid('dee')) $$,
  '42501', null, '"mutual": a stranger cannot ask');
select pg_temp.login('cal');
select lives_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('cal'), pg_temp.uid('ann')), greatest(pg_temp.uid('cal'), pg_temp.uid('ann')), pg_temp.uid('cal')) $$,
  '"mutual": someone with a shared connection can ask');
select pg_temp.login('dee');
select lives_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('dee'), pg_temp.uid('ben')), greatest(pg_temp.uid('dee'), pg_temp.uid('ben')), pg_temp.uid('dee')) $$,
  'default "everyone": anyone can ask');

-- ---------------------------------------------------------------------------------------
-- 4. Reactions
-- ---------------------------------------------------------------------------------------
select pg_temp.login('ann');
select lives_ok($$ insert into public.message_reactions (message_id, user_id, conversation_id, epoch, enc)
  values ('52000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), '51000000-0000-0000-0000-000000000001', 1, 'x') $$,
  'a member reacts');
select lives_ok($$ insert into public.message_reactions (message_id, user_id, conversation_id, epoch, enc)
  values ('52000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), '51000000-0000-0000-0000-000000000001', 1, 'y')
  on conflict (message_id, user_id) do update set enc = excluded.enc, epoch = excluded.epoch $$,
  'changing a reaction replaces it');
select is((select enc from public.message_reactions where user_id = pg_temp.uid('ann')), 'y', 'one reaction per person per message');
select throws_ok($$ insert into public.message_reactions (message_id, user_id, conversation_id, epoch, enc)
  values ('52000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), '51000000-0000-0000-0000-000000000001', 1, 'x') $$,
  '42501', null, 'nobody reacts as someone else');
select pg_temp.login('ben');
select is((select count(*)::int from public.message_reactions), 1, 'members see reactions');
select is((select count(*)::int from public.message_reactions where user_id = pg_temp.uid('ann') and enc = 'y'), 1, 'and whose they are');
update public.message_reactions set enc = null where user_id = pg_temp.uid('ann');
select is((select enc from public.message_reactions where user_id = pg_temp.uid('ann')), 'y', 'nobody changes someone else''s reaction');
select pg_temp.login('dee');
select is((select count(*)::int from public.message_reactions), 0, 'non-members see no reactions');
select throws_ok($$ insert into public.message_reactions (message_id, user_id, conversation_id, epoch, enc)
  values ('52000000-0000-0000-0000-000000000001', pg_temp.uid('dee'), '51000000-0000-0000-0000-000000000001', 1, 'x') $$,
  '42501', null, 'non-members cannot react');

-- A reaction must point at a message of the same conversation.
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values ('50000000-0000-0000-0000-000000000002', pg_temp.uid('ben'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status)
  values ('50000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'member', 'active');
insert into public.conversations (id, audience_id, created_by)
  values ('51000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', pg_temp.uid('ben'));
select pg_temp.login('ann');
select throws_ok($$ insert into public.message_reactions (message_id, user_id, conversation_id, epoch, enc)
  values ('52000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), '51000000-0000-0000-0000-000000000002', 1, 'x')
  on conflict (message_id, user_id) do nothing $$,
  '22023', null, 'reactions cannot be moved to another conversation');

-- Unsend removes the reactions with the message.
select pg_temp.login('ben');
delete from public.messages where id = '52000000-0000-0000-0000-000000000001';
select pg_temp.su();
select is((select count(*)::int from public.message_reactions where message_id = '52000000-0000-0000-0000-000000000001'), 0, 'unsending a message removes its reactions');

-- ---------------------------------------------------------------------------------------
-- 5. Circle chats
-- ---------------------------------------------------------------------------------------
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values ('50000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 'group');
insert into public.audience_members (audience_id, member_id, role, status)
  values ('50000000-0000-0000-0000-000000000003', pg_temp.uid('cal'), 'member', 'active'),
         ('50000000-0000-0000-0000-000000000003', pg_temp.uid('dee'), 'member', 'invited');

select pg_temp.login('dee');
select throws_ok($$ insert into public.conversations (audience_id, created_by) values ('50000000-0000-0000-0000-000000000003', pg_temp.uid('dee')) $$,
  '42501', null, 'an invitee who has not joined cannot start the circle chat');
select pg_temp.login('cal');
select lives_ok($$ insert into public.conversations (id, audience_id, created_by)
  values ('51000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', pg_temp.uid('cal')) $$,
  'any active circle member starts the circle chat');
select pg_temp.login('ann');
select throws_ok($$ insert into public.conversations (audience_id, created_by) values ('50000000-0000-0000-0000-000000000003', pg_temp.uid('ann')) $$,
  '23505', null, 'a circle has only one chat');
select throws_ok($$ insert into public.conversations (audience_id, created_by, dm_key)
  values ('50000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), pg_temp.uid('ann')::text || ':' || pg_temp.uid('cal')::text) $$,
  '42501', null, 'a circle chat is never a DM');
select is((select count(*)::int from public.conversations where id = '51000000-0000-0000-0000-000000000003'), 1, 'the circle owner sees the circle chat');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('52000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000003', pg_temp.uid('ann'), 1, '{}') $$,
  'circle members send messages');
select pg_temp.login('dee');
select is((select count(*)::int from public.messages where conversation_id = '51000000-0000-0000-0000-000000000003'), 0,
  'invitees who have not joined cannot read the circle chat');
select pg_temp.login('cal');
select throws_ok($$ select public.leave_conversation('51000000-0000-0000-0000-000000000003') $$,
  '22023', null, 'circle chats are left by leaving the circle');
select is((select count(*)::int from public.audience_members where audience_id = '50000000-0000-0000-0000-000000000003' and member_id = pg_temp.uid('cal')), 1,
  'and the attempt keeps the circle membership');

-- Push badge counts circle chats and DMs from the private read marker.
select pg_temp.su();
select is(kw.push_badge(pg_temp.uid('cal')), 1, 'push badge counts an unread circle chat');
insert into public.conversation_reads (conversation_id, user_id) values ('51000000-0000-0000-0000-000000000003', pg_temp.uid('cal'));
select is(kw.push_badge(pg_temp.uid('cal')), 0, 'and clears once it is read');

select * from finish();
rollback;
