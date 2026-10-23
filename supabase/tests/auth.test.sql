-- Auth, account & safety tests (migration 20261018000100_auth_safety). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann',  '00000000-0000-0000-0000-0000000a0001'), ('ben', '00000000-0000-0000-0000-0000000a0002'),
  ('cat',  '00000000-0000-0000-0000-0000000a0003'), ('mo',  '00000000-0000-0000-0000-0000000a0004'),
  ('boss', '00000000-0000-0000-0000-0000000a0005');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '@auth.test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'auth', repeat('A', 43), repeat('B', 43) from ids;
insert into public.staff_roles (user_id, role) select id, 'moderator' from ids where name = 'mo';
insert into public.staff_roles (user_id, role) select id, 'admin' from ids where name = 'boss';
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'ann' and b.name = 'ben';
insert into public.key_bundles (user_id, bundle) select id, '{"v":1}' from ids where name in ('ann', 'ben');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated',
    'aal', aal, 'session_id', '00000000-0000-0000-0000-00000000beef')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
select is((select value::text from public.app_settings where key = 'recovery_wait_hours'), '24',
  'recovery waiting period defaults to 24 hours');
select pg_temp.login('boss');
select throws_ok($$ update public.app_settings set value = '"yes"' where key = 'signups_enabled' $$,
  '22023', null, 'flags must be booleans');
select throws_ok($$ update public.app_settings set value = '500' where key = 'recovery_wait_hours' $$,
  '22023', null, 'waiting period is capped at a week');
select lives_ok($$ update public.app_settings set value = '48' where key = 'recovery_wait_hours' $$,
  'admin changes the waiting period');
select is((select updated_by from public.app_settings where key = 'recovery_wait_hours'), pg_temp.uid('boss'),
  'settings record who changed them');
select pg_temp.login('mo');
update public.app_settings set value = 'false' where key = 'signups_enabled';
select is((select value::text from public.app_settings where key = 'signups_enabled'), 'true',
  'moderators cannot change operator settings');

-- ---------------------------------------------------------------------------
-- Server-only tables
-- ---------------------------------------------------------------------------
select pg_temp.login('ann');
select throws_ok($$ select * from public.altcha_spent $$, '42501', null, 'users cannot read spent ALTCHA signatures');
select throws_ok($$ insert into public.altcha_spent (signature) values (repeat('a', 32)) $$, '42501', null,
  'users cannot write spent ALTCHA signatures');
select throws_ok($$ select * from public.notice_emails $$, '42501', null, 'users cannot read the notice log');

-- ---------------------------------------------------------------------------
-- MFA enforcement
-- ---------------------------------------------------------------------------
select pg_temp.su();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), pg_temp.uid('ann'), 'phone', 'totp', 'verified', now(), now(), 'x');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), pg_temp.uid('ben'), 'phone', 'totp', 'unverified', now(), now(), 'y');
select pg_temp.login('ann', 'aal1');
select is((select count(*)::int from public.key_bundles), 0, 'enrolled user with a password-only session cannot read the key bundle');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ann')), 0, 'or any other table');
select throws_ok($$ insert into public.vault (user_id, blob) values (pg_temp.uid('ann'), 'x') $$,
  '42501', null, 'or write anything');
select pg_temp.login('ann', 'aal2');
select is((select count(*)::int from public.key_bundles), 1, 'after the TOTP step the bundle is readable');
select pg_temp.login('ben', 'aal1');
select is((select count(*)::int from public.key_bundles), 1, 'an unverified factor does not lock the account');
select ok((select count(*) >= 20 from pg_policies where policyname = 'require mfa when enrolled'
  and tablename in ('key_bundles', 'vault', 'posts', 'comments', 'messages', 'profiles', 'profile_info', 'audience_keys',
                    'friendships', 'notifications', 'photos', 'albums', 'media_objects', 'recovery_shares', 'recovery_requests',
                    'recovery_responses', 'reports', 'blocks', 'invites', 'likes', 'audiences', 'audience_members')),
  'core tables require MFA when enrolled');

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
select pg_temp.su();
insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent)
  values ('00000000-0000-0000-0000-00000000beef', pg_temp.uid('ben'), now(), now(), 'aal1', 'Firefox'),
         ('00000000-0000-0000-0000-00000000cafe', pg_temp.uid('ben'), now(), now(), 'aal1', 'Safari'),
         ('00000000-0000-0000-0000-00000000dead', pg_temp.uid('cat'), now(), now(), 'aal1', 'Chrome');
select pg_temp.login('ben');
select is((select count(*)::int from public.my_sessions()), 2, 'users list only their own sessions');
select is((select count(*)::int from public.my_sessions() where is_current), 1, 'the current session is marked');
select lives_ok($$ select public.revoke_my_session('00000000-0000-0000-0000-00000000dead') $$, 'revoking someone else''s session is a no-op');
select lives_ok($$ select public.revoke_my_session('00000000-0000-0000-0000-00000000cafe') $$, 'revoke another of my sessions');
select pg_temp.su();
select is((select count(*)::int from auth.sessions where id in ('00000000-0000-0000-0000-00000000cafe', '00000000-0000-0000-0000-00000000dead')), 1,
  'only my own session was revoked');

-- ---------------------------------------------------------------------------
-- Reports keep the metadata needed to verify a disclosed key; staff remove messages
-- ---------------------------------------------------------------------------
select pg_temp.login('ben');
insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  select '10000000-0000-0000-0000-0000000a0001', pg_temp.uid('ben'), pg_temp.uid('ben'), 'status', a.id, 1, '{"v":1}'
  from public.audiences a where a.owner_id = pg_temp.uid('ben') and a.kind = 'friends';
select pg_temp.su();
delete from auth.mfa_factors where user_id = pg_temp.uid('ann');
select pg_temp.login('ann');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  values (pg_temp.uid('ann'), 'post', '10000000-0000-0000-0000-0000000a0001', 'spam', '{"plaintext":{"text":"x"}}');
select is((select stored_meta ->> 'author_id' from public.reports where target_id = '10000000-0000-0000-0000-0000000a0001'),
  pg_temp.uid('ben')::text, 'report snapshots the item''s header metadata');
select pg_temp.login('mo');
select throws_ok($$ update public.reports set stored_meta = '{}' where target_id = '10000000-0000-0000-0000-0000000a0001' $$,
  'P0001', null, 'report metadata is immutable');
select lives_ok($$ update public.reports set status = 'dismissed', decision_note = 'ok' where target_id = '10000000-0000-0000-0000-0000000a0001' $$,
  'staff resolve reports');

select pg_temp.su(); select set_config('request.jwt.claims', '', true);
insert into public.audiences (id, owner_id, kind) values ('20000000-0000-0000-0000-0000000a0001', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id) values ('20000000-0000-0000-0000-0000000a0001', pg_temp.uid('ben'));
insert into public.conversations (id, audience_id, created_by) values ('30000000-0000-0000-0000-0000000a0001', '20000000-0000-0000-0000-0000000a0001', pg_temp.uid('ann'));
insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('31000000-0000-0000-0000-0000000a0001', '30000000-0000-0000-0000-0000000a0001', pg_temp.uid('ann'), 1, '{"v":1}');
select pg_temp.login('ben');
delete from public.messages where id = '31000000-0000-0000-0000-0000000a0001';
select pg_temp.su();
select is((select count(*)::int from public.messages where id = '31000000-0000-0000-0000-0000000a0001'), 1,
  'members cannot delete others'' messages');
select pg_temp.login('mo');
select is((select count(*)::int from public.messages), 0, 'staff cannot read unreported messages');
delete from public.messages where id = '31000000-0000-0000-0000-0000000a0001';
select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('ben'), 'message', '31000000-0000-0000-0000-0000000a0001', 'harassment');
select is((select stored_meta ->> 'audience_id' from public.reports where target_id = '31000000-0000-0000-0000-0000000a0001'),
  '20000000-0000-0000-0000-0000000a0001', 'message reports record the conversation audience');
select pg_temp.login('mo');
select is((select count(*)::int from public.messages), 0, 'staff still cannot read the reported message itself');
select throws_ok($$ select public.mod_remove_content((select id from public.reports where target_id = '31000000-0000-0000-0000-0000000a0001'), '') $$,
  '22023', null, 'removal needs a decision note');
select lives_ok($$ select public.mod_remove_content((select id from public.reports where target_id = '31000000-0000-0000-0000-0000000a0001'), 'threats') $$,
  'staff remove a reported message');
select pg_temp.su();
select is((select count(*)::int from public.messages where id = '31000000-0000-0000-0000-0000000a0001'), 0, 'the message is gone');
select is((select status from public.reports where target_id = '31000000-0000-0000-0000-0000000a0001'), 'actioned', 'and the report is closed');
select is((select count(*)::int from public.moderation_actions where target_user_id = pg_temp.uid('ann') and action = 'remove_content'), 1,
  'the removal is recorded against the author');
select pg_temp.login('ben');
select throws_ok($$ select public.mod_remove_content((select id from public.reports limit 1), 'x') $$,
  '42501', null, 'non-staff cannot remove content');

select pg_temp.login('mo');
select lives_ok($$ insert into public.moderation_actions (moderator_id, target_user_id, action, reason)
  values (pg_temp.uid('mo'), pg_temp.uid('cat'), 'warn', 'test') $$, 'staff record a warning');
select pg_temp.su();
select lives_ok($$ delete from auth.users where id = pg_temp.uid('mo') $$, 'a moderator account can be deleted');
select ok((select moderator_id is null from public.moderation_actions where target_user_id = pg_temp.uid('cat')),
  'their past actions remain');

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
select lives_ok($$ select kw.auth_maintenance() $$, 'maintenance runs');
select is((select count(*)::int from auth.users where id = pg_temp.uid('cat')), 1, 'and never deletes accounts');

select * from finish();
rollback;
