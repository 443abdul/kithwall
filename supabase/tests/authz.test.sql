-- Security review: data exposure & authorisation fixes (docs/v2/06-security-review.md; migrations
-- 20261028010100..010600_authz_*.sql). Each block reproduces the original attack and checks it now fails.
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann & Ben are friends; Ben & Fay are friends (Fay is a friend-of-a-friend of Ann);
-- Dee and Eve share a circle with Ann (Eve takes requests from nobody); Cal is a stranger; Gus is in the
-- opt-in directory; Mo is a moderator, Ada an admin.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-0000000a2001'), ('ben', '00000000-0000-0000-0000-0000000a2002'),
  ('cal', '00000000-0000-0000-0000-0000000a2003'), ('dee', '00000000-0000-0000-0000-0000000a2004'),
  ('eve', '00000000-0000-0000-0000-0000000a2005'), ('fay', '00000000-0000-0000-0000-0000000a2006'),
  ('gus', '00000000-0000-0000-0000-0000000a2007'), ('mo',  '00000000-0000-0000-0000-0000000a2008'),
  ('ada', '00000000-0000-0000-0000-0000000a2009');
grant select on ids to authenticated, service_role;

insert into auth.users (id, email, aud, role) select id, name || '-authz@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, name || 'authz', repeat('A', 43), repeat('B', 43) from ids;
update public.profiles set discoverable = true, display_name_public = 'Gus' where id = (select id from ids where name = 'gus');
insert into public.staff_roles (user_id, role) select id, 'moderator' from ids where name = 'mo';
insert into public.staff_roles (user_id, role) select id, 'admin' from ids where name = 'ada';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.topic(t text) returns void language plpgsql as $$
begin perform set_config('realtime.topic', t, true); end $$;
create function pg_temp.friends(a text, b text) returns void language sql as $$
  insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid(a), pg_temp.uid(b)), greatest(pg_temp.uid(a), pg_temp.uid(b)), 'accepted', pg_temp.uid(a), now()) $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.su();
select pg_temp.friends('ann', 'ben');
select pg_temp.friends('ben', 'fay');
-- Ann's circle with Dee and Eve.
insert into public.audiences (id, owner_id, kind) values ('a2000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'group');
insert into public.groups (id, creator_id, audience_id, privacy) values
  ('a2100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'a2000000-0000-0000-0000-000000000001', 'secret');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('a2000000-0000-0000-0000-000000000001', pg_temp.uid('dee'), 'member', 'active'),
  ('a2000000-0000-0000-0000-000000000001', pg_temp.uid('eve'), 'member', 'active');
insert into public.privacy_prefs (user_id, requests_from) values (pg_temp.uid('eve'), 'nobody');

-- =============================================================================================
-- D1: Realtime DELETE events
-- =============================================================================================
select is((select pubdelete from pg_publication where pubname = 'supabase_realtime'), false,
  'D1: the realtime publication no longer publishes DELETE events (they bypass RLS)');
select ok((select pubinsert and pubupdate from pg_publication where pubname = 'supabase_realtime'), 'inserts and updates still flow (RLS-filtered)');
select ok(not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pokes'),
  'D1: pokes are not published at all');

-- db:<uid> topic: only its owner receives, nobody sends from a client.
select pg_temp.su();
insert into realtime.messages (topic, extension, event, payload, private)
  values ('db:' || pg_temp.uid('ann')::text, 'broadcast', 'change', '{"t":"x"}'::jsonb, true);
select pg_temp.login('ann'); select pg_temp.topic('db:' || pg_temp.uid('ann')::text);
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 1, 'the owner can listen on db:<self>');
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'change', '{}', true) $$, '42501', null, 'nobody can send on a db: topic');
select pg_temp.login('cal'); select pg_temp.topic('db:' || pg_temp.uid('ann')::text);
select is((select count(*)::int from realtime.messages where topic = realtime.topic()), 0, 'D1: a stranger cannot listen on someone else''s db: topic');

-- An unfriend reaches only the two people involved, with no identities in the payload.
select pg_temp.su();
select pg_temp.friends('dee', 'fay');
delete from public.friendships where user_a = least(pg_temp.uid('dee'), pg_temp.uid('fay')) and user_b = greatest(pg_temp.uid('dee'), pg_temp.uid('fay'));
select is((select count(*)::int from realtime.messages where topic in ('db:' || pg_temp.uid('dee')::text, 'db:' || pg_temp.uid('fay')::text)
             and event = 'change' and payload ->> 't' = 'friendships'), 2, 'an unfriend notifies both people on their private topics');
select ok(not exists (select 1 from realtime.messages where event = 'change' and (payload::text like '%' || pg_temp.uid('dee')::text || '%'
             or payload::text like '%' || pg_temp.uid('fay')::text || '%')), 'the broadcast carries no user ids');
select pg_temp.topic('');

-- =============================================================================================
-- D2: forced conversations / ringing
-- =============================================================================================
select pg_temp.login('cal');
insert into public.audiences (id, owner_id, kind) values ('a2000000-0000-0000-0000-0000000000c1', pg_temp.uid('cal'), 'conversation');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000c1', pg_temp.uid('cal'), 'admin', 'active') $$, 'a stranger can make their own empty chat');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000c1', pg_temp.uid('ann'), 'member', 'active') $$, '42501', 'not_connected',
  'D2: a stranger cannot add someone to a chat');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000c1', pg_temp.uid('ann'), 'member', 'invited') $$, '42501', 'not_connected',
  'D2: …not as invited either');
select throws_ok($$ select public.create_conversation('a2000000-0000-0000-0000-0000000000c1', array[pg_temp.uid('ann')], true) $$,
  '42501', 'not_connected', 'D2: create_conversation refuses a stranger');
select is(kw.shares_conversation(pg_temp.uid('cal'), pg_temp.uid('ann')), false, 'D2: so the stranger shares no chat with them');
select is(kw.may_signal(pg_temp.uid('ann')), false, 'D2: and may not signal (inbox) them');
select pg_temp.topic('ring:' || pg_temp.uid('ann')::text);
select throws_ok($$ insert into realtime.messages (topic, extension, event, payload, private)
  values (realtime.topic(), 'broadcast', 'sig', '{}', true) $$, '42501', null, 'D2: nor ring them');
select pg_temp.topic('');

-- L1: nobody adds themselves to someone else's chat (as requested or otherwise).
select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values ('a2000000-0000-0000-0000-0000000000a1', pg_temp.uid('ann'), 'conversation');
select pg_temp.login('cal');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000a1', pg_temp.uid('cal'), 'member', 'requested') $$, '42501', null,
  'L1: a stranger cannot request to join someone''s chat');

-- Connections can.
select pg_temp.login('ann');
insert into public.audiences (id, owner_id, kind) values ('a2000000-0000-0000-0000-0000000000a2', pg_temp.uid('ann'), 'conversation');
select is((select dm_key from public.create_conversation('a2000000-0000-0000-0000-0000000000a2', array[pg_temp.uid('ben')], true)),
  least(pg_temp.uid('ann'), pg_temp.uid('ben'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('ben'))::text,
  'create_conversation makes a DM with a connection');
select is((select count(*)::int from public.audience_members where audience_id = 'a2000000-0000-0000-0000-0000000000a2'), 2,
  'both people are members');
insert into public.audiences (id, owner_id, kind) values ('a2000000-0000-0000-0000-0000000000a3', pg_temp.uid('ann'), 'conversation');
select lives_ok($$ select public.create_conversation('a2000000-0000-0000-0000-0000000000a3', array[pg_temp.uid('ben'), pg_temp.uid('dee')]) $$,
  'a group chat with a friend and a circle co-member who accepts requests');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000a3', pg_temp.uid('eve'), 'member', 'active') $$, '42501', 'not_connected',
  'D2: requests_from = nobody is respected for circle co-members');
select throws_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000a3', pg_temp.uid('fay'), 'member', 'active') $$, '42501', 'not_connected',
  'D2: a friend of a friend cannot be added either');
-- A member who is friends with someone may still bring them in (existing behaviour).
select pg_temp.login('ben');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('a2000000-0000-0000-0000-0000000000a3', pg_temp.uid('fay'), 'member', 'active') $$, 'a member adds their own friend');

-- Notifications only the server or a real trusted-friend setup may produce.
select pg_temp.login('ben');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'recovery_request', 'recovery_request', gen_random_uuid()) $$, '42501', null,
  'D2: a friend cannot forge a "help me recover" prompt');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'recovery_trustee', 'profile', pg_temp.uid('ben')) $$, '42501', null,
  'D2: nor a "you are my trusted friend" notice without a share');
insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
  values (pg_temp.uid('ben'), pg_temp.uid('ann'), gen_random_uuid(), 2, '{"s":"x"}');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ann'), pg_temp.uid('ben'), 'recovery_trustee', 'profile', pg_temp.uid('ben')) $$,
  'with a real share the trustee notice works');

-- =============================================================================================
-- D3: profile listing
-- =============================================================================================
select pg_temp.login('cal');
select is((select count(*)::int from public.profiles where id <> pg_temp.uid('cal') and not discoverable), 0,
  'D3: a stranger cannot list profiles');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ann')), 0, 'D3: nor read one by id');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('gus')), 1, 'discoverable profiles stay findable');
select is((select id from public.find_profile('annauthz')), pg_temp.uid('ann'), 'exact handle lookup finds one person');
select is((select id from public.find_profile('ANNauthz ')), pg_temp.uid('ann'), 'case and spaces are ignored');
select is((select count(*)::int from public.find_profile('ann%')), 0, 'no wildcards');
select is((select count(*)::int from public.find_profile('annauth')), 0, 'no prefix matches');
select pg_temp.login('ann');
select is((select count(*)::int from public.profiles where id in (pg_temp.uid('ben'), pg_temp.uid('fay'), pg_temp.uid('dee'), pg_temp.uid('eve'))), 4,
  'connections, friends of friends and circle co-members are visible');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('cal')), 0, 'strangers are not');
-- A pending request makes both sides visible (invite links work through this).
select pg_temp.login('cal');
insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('cal'), pg_temp.uid('ann')), greatest(pg_temp.uid('cal'), pg_temp.uid('ann')), pg_temp.uid('cal'));
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ann')), 1, 'after a connection request the profile is visible');
select pg_temp.login('mo');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('cal')), 1, 'staff can see profiles (moderation)');
-- Blocks hide the profile from the blocked person, and the lookup too.
select pg_temp.su();
insert into public.blocks (blocker, blocked) values (pg_temp.uid('ann'), pg_temp.uid('cal'));
select pg_temp.login('cal');
select is((select count(*)::int from public.find_profile('annauthz')), 0, 'blocked people cannot look you up');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ann')), 0, 'or see your profile');

-- =============================================================================================
-- D4: forged reports
-- =============================================================================================
select pg_temp.login('cal');
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, target_owner_id, reason, stored_envelope)
  values (pg_temp.uid('cal'), 'group', gen_random_uuid(), pg_temp.uid('ben'), 'child_safety', '{"fake":true}') $$, '42501', null,
  'D4: a report against a group that does not exist (or can''t be seen) is refused');
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('cal'), 'group', 'a2100000-0000-0000-0000-000000000001', 'spam') $$, '42501', null,
  'D4: a secret circle the reporter is not in cannot be reported');
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('cal'), 'profile', pg_temp.uid('ben'), 'spam') $$, '42501', null,
  'D4: nor a profile the reporter cannot see');
select pg_temp.login('ann');
insert into public.reports (reporter_id, target_kind, target_id, target_owner_id, reason, stored_envelope, status)
  values (pg_temp.uid('ann'), 'profile', pg_temp.uid('ben'), pg_temp.uid('dee'), 'harassment', '{"forged":"evidence"}', 'open');
select pg_temp.su();
select is((select target_owner_id from public.reports where reporter_id = pg_temp.uid('ann') and target_kind = 'profile'), pg_temp.uid('ben'),
  'D4: the server derives whose item it is (the reporter''s target_owner_id is ignored)');
select is((select stored_envelope from public.reports where reporter_id = pg_temp.uid('ann') and target_kind = 'profile'), null,
  'D4: reporter-supplied "server evidence" is discarded');
select pg_temp.login('dee');
select lives_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('dee'), 'group', 'a2100000-0000-0000-0000-000000000001', 'spam') $$, 'a member can report their circle');
select pg_temp.su();
select is((select target_owner_id from public.reports where reporter_id = pg_temp.uid('dee')), pg_temp.uid('ann'), 'its owner is derived');

-- L2: report targets are immutable; moderators can't lift admin bans or act against staff.
select pg_temp.login('mo', 'aal2');
select throws_ok($$ update public.reports set target_owner_id = pg_temp.uid('fay') where reporter_id = pg_temp.uid('dee') $$,
  'P0001', null, 'L2: a moderator cannot re-point a report at someone else');
select throws_ok($$ insert into public.moderation_actions (moderator_id, target_user_id, action, reason)
  values (pg_temp.uid('mo'), pg_temp.uid('ada'), 'suspend', 'x') $$, '42501', null, 'L2: a moderator cannot suspend an admin');
select pg_temp.login('ada', 'aal2');
insert into public.moderation_actions (moderator_id, target_user_id, action, reason) values (pg_temp.uid('ada'), pg_temp.uid('cal'), 'ban', 'spam');
select pg_temp.login('mo', 'aal2');
select throws_ok($$ insert into public.moderation_actions (moderator_id, target_user_id, action, reason)
  values (pg_temp.uid('mo'), pg_temp.uid('cal'), 'restore', 'x') $$, '42501', null, 'L2: a moderator cannot lift an admin ban');
select pg_temp.su();
select is((select status from public.profiles where id = pg_temp.uid('cal')), 'banned', 'the ban stands');
update public.profiles set status = 'active' where id = pg_temp.uid('cal');

-- =============================================================================================
-- L3: invites
-- =============================================================================================
select pg_temp.login('ann');
insert into public.invites (code, inviter_id, max_uses, expires_at) values ('authzinvite1', pg_temp.uid('ann'), 2, now() + interval '10 years');
select pg_temp.su();
select ok((select expires_at <= now() + interval '30 days 1 minute' from public.invites where code = 'authzinvite1'), 'L3: invites live at most 30 days');
select pg_temp.login('gus');
select lives_ok($$ select public.redeem_invite('authzinvite1') $$, 'an invite can be redeemed');
select pg_temp.login('ann');
select throws_ok($$ update public.invites set uses = 0 where code = 'authzinvite1' $$, '42501', null, 'L3: the inviter cannot reset the use count');
select throws_ok($$ update public.invites set expires_at = now() + interval '1 year' where code = 'authzinvite1' $$, '42501', null,
  'L3: nor extend it');
select pg_temp.login('cal');
select throws_ok($$ select public.redeem_invite('authzinvite1') $$, 'P0001', null, 'L3: someone the inviter blocked cannot redeem it');
select pg_temp.login('ann');
select lives_ok($$ delete from public.invites where code = 'authzinvite1' $$, 'the inviter can revoke it');

-- =============================================================================================
-- P1 / L5: blocked people lose the 1:1 history
-- =============================================================================================
select pg_temp.login('ann');
insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  select 'a2300000-0000-0000-0000-000000000001', c.id, pg_temp.uid('ann'), 1, '{"v":1}' from public.conversations c
   where c.audience_id = 'a2000000-0000-0000-0000-0000000000a2';
select pg_temp.login('ben');
select is((select count(*)::int from public.messages where id = 'a2300000-0000-0000-0000-000000000001'), 1, 'Ben reads the DM');
select pg_temp.su();
insert into public.blocks (blocker, blocked) values (pg_temp.uid('ann'), pg_temp.uid('ben'));
select pg_temp.login('ben');
select is((select count(*)::int from public.messages where id = 'a2300000-0000-0000-0000-000000000001'), 0,
  'P1: once Ann blocks Ben, Ben can no longer read their 1:1 history');
select pg_temp.login('ann');
select is((select count(*)::int from public.messages where id = 'a2300000-0000-0000-0000-000000000001'), 1, 'Ann (the blocker) still can');

-- =============================================================================================
-- L4: storage quota
-- =============================================================================================
select pg_temp.su();
insert into public.media_objects (path, owner_id, bytes)
  select pg_temp.uid('dee')::text || '/' || gen_random_uuid()::text, pg_temp.uid('dee'), 31457280 from generate_series(1, 345);
select pg_temp.login('dee');
select is(kw.media_quota_ok(), false, 'L4: an account over 10 GiB of files cannot upload more');
select pg_temp.login('fay');
select is(kw.media_quota_ok(), true, 'others can');
select ok(not has_function_privilege('authenticated', 'public.orphaned_media(int)', 'execute'), 'only the server lists orphaned uploads');

-- =============================================================================================
-- L7, reserved handles, I1
-- =============================================================================================
select pg_temp.su();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), pg_temp.uid('fay'), 'phone', 'totp', 'verified', now(), now(), 'x');
select pg_temp.login('fay', 'aal1');
select throws_ok($$ select public.request_account_deletion() $$, '42501', null, 'L7: deletion needs the second step when enrolled');
select pg_temp.login('fay', 'aal2');
select lives_ok($$ select public.request_account_deletion() $$, 'with it, deletion can be scheduled');

select ok(kw.is_reserved_username('donate'), '"donate" is a reserved handle (matches lib/social/reserved.ts)');
select ok(not has_table_privilege('authenticated', 'public.posts', 'TRUNCATE'), 'I1: no TRUNCATE for signed-in users');
select ok(not has_table_privilege('anon', 'public.profiles', 'TRIGGER'), 'I1: no TRIGGER for anon');

-- Deleting an account someone reported still works: the FK clears the report's target_owner_id.
select pg_temp.su();
select lives_ok($$ delete from auth.users where id = pg_temp.uid('ann') $$, 'a reported account can still be deleted');
select is((select target_owner_id from public.reports where reporter_id = pg_temp.uid('dee')), null, 'the report stays, without its owner');

select * from finish();
rollback;
