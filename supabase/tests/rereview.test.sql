-- Security re-review fixes (docs/v2/06-security-review.md §10.2; migrations 20261029000100..000300).
-- Each block replays the re-review's probe and checks it now fails. (R-K-1 is client code: see
-- apps/web/src/lib/keys/keyswap.e2e.test.ts and authority.test.ts.)
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ola owns a circle with Ali (member) and Mel (member); Rex asks to join Ola's closed group;
-- Ivy is invited to it; Sam is a stranger. Ola is friends with Ali and Ivy.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ola', '00000000-0000-0000-0000-0000000b3001'), ('ali', '00000000-0000-0000-0000-0000000b3002'),
  ('mel', '00000000-0000-0000-0000-0000000b3003'), ('rex', '00000000-0000-0000-0000-0000000b3004'),
  ('ivy', '00000000-0000-0000-0000-0000000b3005'), ('sam', '00000000-0000-0000-0000-0000000b3006');
grant select on ids to authenticated, service_role;
insert into auth.users (id, email, aud, role) select id, name || '-rr@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, name || 'rrev', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.service() returns void language plpgsql as $$
begin perform set_config('role', 'service_role', true); perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.su();
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid('ola'), pg_temp.uid('ali')), greatest(pg_temp.uid('ola'), pg_temp.uid('ali')), 'accepted', pg_temp.uid('ola'), now()),
         (least(pg_temp.uid('ola'), pg_temp.uid('ivy')), greatest(pg_temp.uid('ola'), pg_temp.uid('ivy')), 'accepted', pg_temp.uid('ola'), now());
-- Ola's circle (secret group) with Ali and Mel.
insert into public.audiences (id, owner_id, kind) values ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ola'), 'group');
insert into public.groups (id, creator_id, audience_id, privacy) values
  ('b3100000-0000-0000-0000-000000000001', pg_temp.uid('ola'), 'b3000000-0000-0000-0000-000000000001', 'secret');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ola'), 'admin', 'active'),
  ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ali'), 'member', 'active'),
  ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('mel'), 'member', 'active');

-- =============================================================================================
-- R-K-2: ghost admins. Promotions carry a grant signed by the owner/admin who made them.
-- =============================================================================================
select pg_temp.login('ali');
select throws_ok($$ update public.audience_members set role = 'admin', grant_by = pg_temp.uid('ali'), grant_sig = repeat('s', 86)
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali') $$, 'P0001', null,
  'a member cannot make themselves admin, signed or not');
select pg_temp.login('ola');
select throws_ok($$ update public.audience_members set role = 'admin'
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali') $$, '42501', null,
  'R-K-2: an unsigned promotion is refused');
select throws_ok($$ update public.audience_members set role = 'admin', grant_by = pg_temp.uid('mel'), grant_sig = repeat('s', 86)
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali') $$, '42501', null,
  'R-K-2: a grant must name the person who made it');
select lives_ok($$ update public.audience_members set role = 'admin', grant_by = pg_temp.uid('ola'), grant_sig = repeat('s', 86)
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali') $$,
  'the owner promotes Ali with a signed grant');
select ok(kw.is_key_authority('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ali')), 'a signed admin is a key authority');
select is((select count(*)::int from public.audience_roster_notices where audience_id = 'b3000000-0000-0000-0000-000000000001'
             and member_id = pg_temp.uid('ali') and kind = 'admin' and actor_id = pg_temp.uid('ola')), 1,
  'R-K-2: members get a server notice "Ola made Ali an admin"');
select pg_temp.login('mel');
select is((select count(*)::int from public.audience_roster_notices where audience_id = 'b3000000-0000-0000-0000-000000000001' and kind = 'admin'), 1,
  'R-K-2: other members can read the notice');
select throws_ok($$ insert into public.audience_roster_notices (audience_id, member_id, kind)
  values ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('mel'), 'admin') $$, '42501', null, 'nobody forges roster notices');
select pg_temp.login('sam');
select is((select count(*)::int from public.audience_roster_notices), 0, 'non-members see no roster notices');

-- The operator's ghost admin (a role flipped without a grant, as a superuser could) mints nothing.
select pg_temp.su();
set local session_replication_role = replica;
update public.audience_members set role = 'admin' where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('mel');
set local session_replication_role = origin;
select ok(not kw.is_key_authority('b3000000-0000-0000-0000-000000000001', pg_temp.uid('mel')),
  'R-K-2: an admin without a signed grant is not a key authority');
select pg_temp.login('mel');
select throws_ok($$ select public.advance_audience_epoch('b3000000-0000-0000-0000-000000000001', 1, repeat('c', 43), repeat('s', 86)) $$,
  '42501', null, 'R-K-2: ...so the ghost admin cannot rotate');

-- Demotion clears the grant (and the client rotates, R-K-4).
select pg_temp.login('ola');
select lives_ok($$ update public.audience_members set role = 'member'
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali') $$, 'the owner demotes Ali');
select pg_temp.su();
select is((select grant_sig from public.audience_members where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ali')),
  null, 'a demotion clears the grant');
select ok(not kw.is_key_authority('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ali')), 'a demoted admin is no key authority');

-- Joining is announced too.
select pg_temp.login('ola');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('b3000000-0000-0000-0000-000000000001', pg_temp.uid('ivy'), 'member', 'invited') $$, 'the owner invites Ivy');
select pg_temp.su();
select is((select count(*)::int from public.audience_roster_notices where member_id = pg_temp.uid('ivy')), 0, 'an invitation alone is not announced');
-- (Accepting the invitation makes her active.)
select pg_temp.login('ivy');
select lives_ok($$ update public.audience_members set status = 'active'
  where audience_id = 'b3000000-0000-0000-0000-000000000001' and member_id = pg_temp.uid('ivy') $$, 'Ivy accepts');
select pg_temp.su();
select is((select kind from public.audience_roster_notices where member_id = pg_temp.uid('ivy')), 'joined', 'R-K-2: "Ivy joined" is announced');

-- Group chats: a server notice in the thread when someone is added; none for 1:1 chats or at creation.
select pg_temp.login('ola');
select lives_ok($$ insert into public.audiences (id, owner_id, kind) values ('b3000000-0000-0000-0000-000000000002', pg_temp.uid('ola'), 'conversation') $$, 'chat audience');
select lives_ok($$ select public.create_conversation('b3000000-0000-0000-0000-000000000002', array[pg_temp.uid('ali')], false) $$, 'group chat with Ali');
select pg_temp.su();
select is((select count(*)::int from public.messages m join public.conversations c on c.id = m.conversation_id
            where c.audience_id = 'b3000000-0000-0000-0000-000000000002' and m.notice is not null), 0, 'no notices for the people a chat starts with');
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid('ola'), pg_temp.uid('mel')), greatest(pg_temp.uid('ola'), pg_temp.uid('mel')), 'accepted', pg_temp.uid('ola'), now());
select pg_temp.login('ola');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status, invited_by)
  values ('b3000000-0000-0000-0000-000000000002', pg_temp.uid('mel'), 'member', 'active', pg_temp.uid('ola')) $$, 'Ola adds Mel to the chat');
select pg_temp.login('ali');
select is((select m.notice from public.messages m join public.conversations c on c.id = m.conversation_id
            where c.audience_id = 'b3000000-0000-0000-0000-000000000002' and m.notice is not null),
  jsonb_build_object('kind', 'roster', 'what', 'joined', 'm', pg_temp.uid('mel')),
  'R-K-2: chat members see a content-free server notice that Mel joined');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope, notice)
  select gen_random_uuid(), c.id, pg_temp.uid('ali'), 1, '{}'::jsonb, '{"kind":"roster","what":"admin"}'::jsonb
    from public.conversations c where c.audience_id = 'b3000000-0000-0000-0000-000000000002' $$, '42501', null,
  'clients cannot forge roster notices in chats');
-- Ownership hand-over is announced.
select pg_temp.login('ola');
select lives_ok($$ select public.leave_conversation((select id from public.conversations where audience_id = 'b3000000-0000-0000-0000-000000000002')) $$,
  'the owner leaves the group chat');
select pg_temp.login('ali');
select is((select count(*)::int from public.messages m join public.conversations c on c.id = m.conversation_id
            where c.audience_id = 'b3000000-0000-0000-0000-000000000002' and m.notice ->> 'what' = 'owner'), 1,
  'R-K-2: the new owner of the chat is announced');
select is((select owner_id from public.audiences where id = 'b3000000-0000-0000-0000-000000000002'), pg_temp.uid('ali'), 'Ali owns it now');

-- =============================================================================================
-- R-K-3: a member relays garbage for the current epoch first; the authority's delivery wins.
-- =============================================================================================
select pg_temp.su();
insert into public.audiences (id, owner_id, kind, current_epoch) values ('b3000000-0000-0000-0000-000000000003', pg_temp.uid('ola'), 'conversation', 1);
insert into public.audience_members (audience_id, member_id, role, status) values
  ('b3000000-0000-0000-0000-000000000003', pg_temp.uid('ola'), 'admin', 'active'),
  ('b3000000-0000-0000-0000-000000000003', pg_temp.uid('ali'), 'member', 'active'),
  ('b3000000-0000-0000-0000-000000000003', pg_temp.uid('mel'), 'member', 'active');
insert into public.audience_epochs (audience_id, epoch, rotated_by, commit, sig)
  values ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('ola'), repeat('c', 43), repeat('s', 86));
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed) values
  ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('ali'), pg_temp.uid('ola'), '{"k":"owner"}'),
  ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('ola'), pg_temp.uid('ola'), '{"k":"owner"}');
select pg_temp.login('ali');
select lives_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('mel'), pg_temp.uid('ali'), '{"k":"garbage"}') $$,
  'Ali relays garbage to Mel before the owner delivers (allowed: Mel judges it)');
select results_eq($$ with u as (update public.audience_keys set sealed = '{"k":"more garbage"}'
  where audience_id = 'b3000000-0000-0000-0000-000000000003' and sealed_by = pg_temp.uid('ali') returning 1) select count(*)::int from u $$,
  array[0], 'R-K-3: the relayer cannot rewrite its delivery later');
select pg_temp.login('ola');
select is((select count(*)::int from public.pending_key_deliveries() where audience_id = 'b3000000-0000-0000-0000-000000000003' and recipient_id = pg_temp.uid('mel')), 1,
  'R-K-3: for the owner, a relay does not count as delivered');
select lives_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('mel'), pg_temp.uid('ola'), '{"k":"owner"}') $$,
  'R-K-3: the owner''s delivery is accepted over the relay (no 23505)');
select pg_temp.su();
select is((select sealed_by from public.audience_keys where audience_id = 'b3000000-0000-0000-0000-000000000003' and recipient_id = pg_temp.uid('mel')),
  pg_temp.uid('ola'), 'R-K-3: ...and replaced it');
select pg_temp.login('ali');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values ('b3000000-0000-0000-0000-000000000003', 1, pg_temp.uid('mel'), pg_temp.uid('ali'), '{"k":"garbage"}') $$, '23505', null,
  'R-K-3: the relayer cannot push the owner''s delivery out again');
select pg_temp.login('mel');
select lives_ok($$ delete from public.audience_keys where audience_id = 'b3000000-0000-0000-0000-000000000003' and recipient_id = pg_temp.uid('mel') and sealed_by = pg_temp.uid('ali') $$,
  'deleting a (gone) relay is harmless');
select is((select count(*)::int from public.audience_keys where audience_id = 'b3000000-0000-0000-0000-000000000003' and recipient_id = pg_temp.uid('mel')), 1,
  'Mel keeps the owner''s key');

-- =============================================================================================
-- R-K-5: a stolen session can no longer overwrite the key bundle.
-- =============================================================================================
select pg_temp.su();
insert into public.key_bundles (user_id, bundle) values (pg_temp.uid('sam'), '{"v":1,"signPub":"x"}');
select pg_temp.login('sam');
select results_eq($$ with u as (update public.key_bundles set bundle = '{"v":1,"junk":true}' where user_id = pg_temp.uid('sam') returning 1) select count(*)::int from u $$,
  array[0], 'R-K-5: a session alone cannot overwrite the key bundle');
select is((select bundle from public.key_bundles where user_id = pg_temp.uid('sam')), '{"v":1,"signPub":"x"}'::jsonb, 'the bundle is untouched');
select lives_ok($$ select * from public.create_key_challenge('update_bundle') $$, 'a proof-of-key for bundle updates can be requested');

-- =============================================================================================
-- R-W3: the passphrase check costs one bcrypt whatever the input, and only the server may call it.
-- =============================================================================================
select pg_temp.su();
insert into auth.users (id, email, aud, role, encrypted_password) values
  ('00000000-0000-0000-0000-0000000b3101', 'u000000000000000000000000000b3101@id.kithwall.invalid', 'authenticated', 'authenticated',
   extensions.crypt('right-auth-key', extensions.gen_salt('bf', 10))),
  ('00000000-0000-0000-0000-0000000b3102', 'u000000000000000000000000000b3102@id.kithwall.invalid', 'authenticated', 'authenticated', '');
select pg_temp.service();
select is(public.passphrase_password_ok('u000000000000000000000000000b3101@id.kithwall.invalid', 'right-auth-key'),
  '00000000-0000-0000-0000-0000000b3101'::uuid, 'the right key signs in');
select is(public.passphrase_password_ok('u000000000000000000000000000b3101@id.kithwall.invalid', 'wrong'), null, 'a wrong key does not');
select is(public.passphrase_password_ok('u000000000000000000000000000b3102@id.kithwall.invalid', ''), null, 'an account without a password never matches');
select is(public.passphrase_password_ok('u00000000000000000000000000ffffff@id.kithwall.invalid', 'x'), null, 'an unknown address does not');
select is(public.passphrase_password_ok('someone@example.com', 'x'), null, 'only synthetic addresses');
select pg_temp.login('sam');
select throws_ok($$ select public.passphrase_password_ok('u000000000000000000000000000b3101@id.kithwall.invalid', 'x') $$, '42501', null,
  'R-W3: clients cannot call the password check');

-- =============================================================================================
-- N-A1: a pending join request gives no visibility or notification rights toward the owner.
-- =============================================================================================
select pg_temp.su();
insert into public.privacy_prefs (user_id, requests_from) values (pg_temp.uid('ola'), 'nobody');
insert into public.audiences (id, owner_id, kind) values ('b3000000-0000-0000-0000-000000000004', pg_temp.uid('ola'), 'group');
insert into public.groups (id, creator_id, audience_id, privacy) values
  ('b3100000-0000-0000-0000-000000000004', pg_temp.uid('ola'), 'b3000000-0000-0000-0000-000000000004', 'closed');
select pg_temp.login('rex');
select lives_ok($$ insert into public.audience_members (audience_id, member_id, role, status)
  values ('b3000000-0000-0000-0000-000000000004', pg_temp.uid('rex'), 'member', 'requested') $$, 'Rex asks to join Ola''s closed group');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('ola')), 0, 'N-A1: the request does not reveal the owner''s profile');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ola'), pg_temp.uid('rex'), 'comment', 'post', gen_random_uuid()) $$, '42501', null,
  'N-A1: ...nor lets the requester notify (push) the owner');
select pg_temp.login('ola');
select is((select count(*)::int from public.profiles where id = pg_temp.uid('rex')), 1, 'the owner still sees who asked');

-- =============================================================================================
-- N-A2: circle co-members can't send made-up notifications.
-- =============================================================================================
select pg_temp.login('mel');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ali'), pg_temp.uid('mel'), 'comment', 'post', gen_random_uuid()) $$, '42501', null,
  'N-A2: a co-member cannot send a comment notification about a post that does not exist');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ali'), pg_temp.uid('mel'), 'mention', 'profile', pg_temp.uid('mel')) $$, '42501', null,
  'N-A2: nor any type the app does not send');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ali'), pg_temp.uid('mel'), 'group_invite', 'group', 'b3100000-0000-0000-0000-000000000004') $$, '42501', null,
  'N-A2: nor an invitation to a group the recipient was not invited to');
-- A real comment on a real post notifies its author.
select pg_temp.su();
insert into public.posts (id, author_id, group_id, kind, audience_id, epoch, envelope)
  values ('b3200000-0000-0000-0000-000000000001', pg_temp.uid('ali'), 'b3100000-0000-0000-0000-000000000001', 'status', 'b3000000-0000-0000-0000-000000000001', 1, '{}');
insert into public.comments (id, post_id, author_id, envelope)
  values ('b3300000-0000-0000-0000-000000000001', 'b3200000-0000-0000-0000-000000000001', pg_temp.uid('mel'), '{}');
select pg_temp.login('mel');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ali'), pg_temp.uid('mel'), 'comment', 'post', 'b3200000-0000-0000-0000-000000000001') $$,
  'a comment notification about a real comment still works');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ali'), pg_temp.uid('mel'), 'like', 'post', 'b3200000-0000-0000-0000-000000000001') $$, '42501', null,
  'N-A2: a like notification needs a like');

select * from finish();
rollback;
