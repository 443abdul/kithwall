-- Key authority and identity keys (security review K1, K2, W2; migrations 20261028000100_keys_audience_authority
-- and 20261028000200_keys_identity). Every attack from the review is replayed as the attacker's role and
-- must now fail. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Alice owns a group chat with Bob and Mallory (all connected) and a closed group with Mallory as a
-- plain member. Mallory is the malicious member from the review.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000081a1'), ('bob', '00000000-0000-0000-0000-0000000081b0'),
  ('mallory', '00000000-0000-0000-0000-0000000081d0'), ('erin', '00000000-0000-0000-0000-0000000081e0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-keys@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'keyst', repeat('A', 43), repeat('B', 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name < b.name and a.name in ('alice', 'bob', 'mallory') and b.name in ('alice', 'bob', 'mallory');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Chat C (owner Alice) and closed group G (owner Alice).
insert into public.audiences (id, owner_id, kind) values
  ('80000000-0000-0000-0000-0000000000c1', pg_temp.uid('alice'), 'conversation'),
  ('80000000-0000-0000-0000-0000000000a1', pg_temp.uid('alice'), 'group');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('80000000-0000-0000-0000-0000000000c1', pg_temp.uid('alice'), 'admin', 'active'),
  ('80000000-0000-0000-0000-0000000000c1', pg_temp.uid('bob'), 'member', 'active'),
  ('80000000-0000-0000-0000-0000000000c1', pg_temp.uid('mallory'), 'member', 'active'),
  ('80000000-0000-0000-0000-0000000000a1', pg_temp.uid('alice'), 'admin', 'active'),
  ('80000000-0000-0000-0000-0000000000a1', pg_temp.uid('mallory'), 'member', 'active');
insert into public.conversations (id, audience_id, created_by)
  values ('81000000-0000-0000-0000-0000000000c1', '80000000-0000-0000-0000-0000000000c1', pg_temp.uid('alice'));

create function pg_temp.plant(aud text, ep int, recipient text, sealer text) returns void language sql as $$
  insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  values (aud::uuid, ep, pg_temp.uid(recipient), pg_temp.uid(sealer), '{"v":1}')
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------------------------
-- K1: the review's probe. A non-owner member plants keys for epochs 2, 7 and 99 (current epoch 1).
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('mallory');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 2, 'alice', 'mallory') $$, '42501', null,
  'K1: a member cannot plant a chat key for the next epoch (addressed to the owner)');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 7, 'bob', 'mallory') $$, '42501', null,
  'K1: a member cannot plant a chat key for a far-future epoch');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 99, 'bob', 'mallory') $$, '42501', null,
  'K1: epoch 99 is refused too');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 1, 'bob', 'mallory') $$, '42501', null,
  'K1: a member cannot relay the current chat key before its owner recorded it');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000a1', 1, 'alice', 'mallory') $$, '42501', null,
  'K1: a plain group member cannot seal a group key');
select throws_ok($$ select public.advance_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('C', 43), repeat('S', 86)) $$,
  '42501', null, 'K1: a plain member cannot rotate the chat key');
select throws_ok($$ select public.record_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('C', 43), repeat('S', 86)) $$,
  '42501', null, 'K1: a plain member cannot publish the epoch record');
select pg_temp.su();
select is((select count(*)::int from public.audience_keys where audience_id = '80000000-0000-0000-0000-0000000000c1'), 0,
  'K1: nothing was planted');

-- The owner records epoch 1 and delivers it; now a member may relay the CURRENT key (clients check it
-- against the record), but still not to a non-member and never for another epoch.
select pg_temp.login('alice');
select is(public.record_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('C', 43), repeat('S', 86)), true,
  'the owner records the key of the current epoch');
select is(public.record_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('D', 43), repeat('S', 86)), false,
  'a record cannot be replaced');
select throws_ok($$ select public.record_audience_epoch('80000000-0000-0000-0000-0000000000c1', 2, repeat('C', 43), repeat('S', 86)) $$,
  '22023', null, 'records are only for the current epoch');
select lives_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 1, 'alice', 'alice') $$, 'the owner keeps a copy');
select lives_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 1, 'mallory', 'alice') $$, 'the owner delivers to Mallory');
select pg_temp.login('mallory');
select lives_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 1, 'bob', 'mallory') $$,
  'a member may relay the recorded current key (the client checks it against the record)');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 1, 'erin', 'mallory') $$, '42501', null,
  'never to a non-member');
select lives_ok($$ update public.audience_epochs set commit = repeat('E', 43) where audience_id = '80000000-0000-0000-0000-0000000000c1' $$,
  'a member''s attempt to rewrite the owner''s record touches nothing');
-- Security re-review R-K-3: a relaying member may no longer rewrite its delivery (it could keep replacing a
-- key with garbage); only key authorities re-sign theirs.
select results_eq($$ with u as (update public.audience_keys set sealed = '{"v":2}' where audience_id = '80000000-0000-0000-0000-0000000000c1' and sealed_by = pg_temp.uid('mallory') returning 1) select count(*)::int from u $$,
  array[0], 'R-K-3: a relaying member cannot rewrite its own delivery');
select results_eq($$ with u as (update public.audience_keys set epoch = 2 where audience_id = '80000000-0000-0000-0000-0000000000c1' and sealed_by = pg_temp.uid('mallory') returning 1) select count(*)::int from u $$,
  array[0], 'nor move it to another epoch');
select results_eq($$ with u as (update public.audience_keys set recipient_id = pg_temp.uid('alice') where audience_id = '80000000-0000-0000-0000-0000000000c1' and sealed_by = pg_temp.uid('mallory') returning 1) select count(*)::int from u $$,
  array[0], 'or to another recipient');
select lives_ok($$ update public.audience_keys set sealed = '{"v":3}' where audience_id = '80000000-0000-0000-0000-0000000000c1' and sealed_by = pg_temp.uid('alice') $$,
  'a member''s update of the owner''s deliveries touches nothing');
select pg_temp.login('alice');
select throws_ok($$ update public.audience_epochs set commit = repeat('E', 43) where audience_id = '80000000-0000-0000-0000-0000000000c1' $$,
  '42501', null, 'even its author cannot change a record''s commitment (only re-sign it)');
select lives_ok($$ update public.audience_epochs set sig = repeat('T', 86) where audience_id = '80000000-0000-0000-0000-0000000000c1' $$,
  'its author may renew the signature');
select pg_temp.su();
select is((select commit from public.audience_epochs where audience_id = '80000000-0000-0000-0000-0000000000c1' and epoch = 1),
  repeat('C', 43), 'the record is unchanged');
select is((select sealed::text from public.audience_keys where audience_id = '80000000-0000-0000-0000-0000000000c1' and recipient_id = pg_temp.uid('mallory')),
  '{"v": 1}', 'the owner''s delivery is unchanged');

-- Bob discards the relayed copy (e.g. it failed the record check) so the owner's delivery can replace it.
select pg_temp.login('bob');
select lives_ok($$ delete from public.audience_keys where audience_id = '80000000-0000-0000-0000-0000000000c1' and recipient_id = pg_temp.uid('bob') $$,
  'a recipient may discard a key addressed to them');
select pg_temp.su();
select is((select count(*)::int from public.audience_keys where audience_id = '80000000-0000-0000-0000-0000000000c1' and recipient_id = pg_temp.uid('bob')), 0,
  'the relayed copy is gone');

-- The review's exploit end to end: Mallory is removed; the owner rotates atomically with a record.
-- Mallory (no longer a member) cannot plant or obtain the new key, and nobody can seal it to her.
select pg_temp.login('alice');
delete from public.audience_members where audience_id = '80000000-0000-0000-0000-0000000000c1' and member_id = pg_temp.uid('mallory');
select is(public.advance_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('F', 43), repeat('S', 86)), 2,
  'the owner rotates and records epoch 2 in one step');
select is(public.advance_audience_epoch('80000000-0000-0000-0000-0000000000c1', 1, repeat('G', 43), repeat('S', 86)), null::int,
  'a second rotation from the same epoch loses the race (no second key for epoch 2)');
select pg_temp.su();
select is((select rotated_by from public.audience_epochs where audience_id = '80000000-0000-0000-0000-0000000000c1' and epoch = 2),
  pg_temp.uid('alice'), 'epoch 2 is attributed to the owner');
select pg_temp.login('mallory');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 2, 'bob', 'mallory') $$, '42501', null,
  'K1: the removed member cannot plant the new epoch');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 3, 'alice', 'mallory') $$, '42501', null,
  'K1: nor any later epoch');
select pg_temp.login('bob');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 2, 'mallory', 'bob') $$, '42501', null,
  'K1: a remaining member cannot hand the new key to the removed member');
select pg_temp.login('alice');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 2, 'mallory', 'alice') $$, '42501', null,
  'K1: not even the owner can seal it to someone who left');
select lives_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000c1', 2, 'bob', 'alice') $$, 'the owner delivers epoch 2 to Bob');
select pg_temp.login('mallory');
select is((select count(*)::int from public.audience_keys where audience_id = '80000000-0000-0000-0000-0000000000c1' and epoch = 2), 0,
  'the removed member sees no epoch-2 key');
select is((select count(*)::int from public.audience_epochs where audience_id = '80000000-0000-0000-0000-0000000000c1' and epoch = 2), 0,
  'nor its record');

-- Group: the owner (an admin) seals history for members; a plain member never seals.
select pg_temp.login('alice');
select lives_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000a1', 1, 'mallory', 'alice') $$, 'a group admin seals the current key');
select throws_ok($$ select pg_temp.plant('80000000-0000-0000-0000-0000000000a1', 2, 'mallory', 'alice') $$, '42501', null,
  'K1: even an admin cannot seal a key for an epoch that does not exist yet');

-- Friends audience: only its owner seals; a friend cannot plant a key addressed to the owner.
select pg_temp.login('mallory');
select throws_ok($$ insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
  select a.id, 1, pg_temp.uid('alice'), pg_temp.uid('mallory'), '{"v":1}' from public.audiences a
   where a.owner_id = pg_temp.uid('alice') and a.kind = 'friends' $$, '42501', null,
  'K1: a friend cannot plant a key into someone''s Friends audience');

-- Migration cleanup: rows above the current epoch are gone everywhere.
select pg_temp.su();
select is((select count(*)::int from public.audience_keys k join public.audiences a on a.id = k.audience_id where k.epoch > a.current_epoch), 0,
  'no key rows exist for future epochs');

-- ---------------------------------------------------------------------------------------------
-- K2: identity keys
-- ---------------------------------------------------------------------------------------------
insert into public.key_bundles (user_id, bundle) values (pg_temp.uid('bob'), '{"v":1,"signPub":"x"}');
select pg_temp.login('bob');
select throws_ok($$ update public.profiles set sign_pub = repeat('Z', 43), kx_pub = repeat('Y', 43) where id = pg_temp.uid('bob') $$,
  '42501', null, 'K2: an (aal1) session cannot replace its identity keys');
select throws_ok($$ update public.profiles set key_version = 7 where id = pg_temp.uid('bob') $$, '42501', null,
  'K2: nor bump the key version');
select lives_ok($$ update public.profiles set discoverable = false where id = pg_temp.uid('bob') $$, 'other profile fields still update');
select throws_ok($$ insert into public.key_changes (user_id, change, sig) values (pg_temp.uid('bob'), '{}', 'x') $$, '42501', null,
  'K2: clients cannot write the key-change log');
select throws_ok($$ select public.apply_identity_key_change(pg_temp.uid('bob'), '{}', 'x', '{}') $$, '42501', null,
  'K2: the key-change function is not callable by users');
select pg_temp.su();
select is((select sign_pub from public.profiles where id = pg_temp.uid('bob')), repeat('A', 43), 'Bob''s key is unchanged');
select throws_ok($$ update public.profiles set sign_pub = repeat('Z', 43) where id = pg_temp.uid('bob') $$, '42501', null,
  'K2: even the service role / operator cannot swap keys outside the signed change');

-- The signed change (after the route verified the signatures).
set local role service_role;
select throws_ok($$ select public.apply_identity_key_change(pg_temp.uid('bob'),
  jsonb_build_object('userId', pg_temp.uid('bob'), 'oldSignPub', repeat('Q', 43), 'newSignPub', repeat('Z', 43), 'newKxPub', repeat('Y', 43), 'at', 'now'),
  repeat('S', 86), '{"signPub":"ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ","kxPub":"YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY"}') $$,
  '40001', null, 'a change must start from the current key');
select throws_ok($$ select public.apply_identity_key_change(pg_temp.uid('bob'),
  jsonb_build_object('userId', pg_temp.uid('bob'), 'oldSignPub', repeat('A', 43), 'newSignPub', repeat('Z', 43), 'newKxPub', repeat('Y', 43), 'at', 'now'),
  repeat('S', 86), '{"signPub":"other","kxPub":"YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY"}') $$,
  '22023', null, 'the new bundle must carry the new keys');
select is(public.apply_identity_key_change(pg_temp.uid('bob'),
  jsonb_build_object('userId', pg_temp.uid('bob'), 'oldSignPub', repeat('A', 43), 'newSignPub', repeat('Z', 43), 'newKxPub', repeat('Y', 43), 'at', 'now'),
  repeat('S', 86), jsonb_build_object('v', 1, 'signPub', repeat('Z', 43), 'kxPub', repeat('Y', 43))), 2,
  'a verified signed change swaps the keys and bumps the version');
select pg_temp.su();
select is((select sign_pub || '/' || kx_pub from public.profiles where id = pg_temp.uid('bob')), repeat('Z', 43) || '/' || repeat('Y', 43), 'new keys published');
select is((select bundle ->> 'signPub' from public.key_bundles where user_id = pg_temp.uid('bob')), repeat('Z', 43), 'bundle swapped in the same step');
select is((select change ->> 'oldSignPub' from public.key_changes where user_id = pg_temp.uid('bob')), repeat('A', 43), 'the signed change is logged for contacts');

-- ---------------------------------------------------------------------------------------------
-- W2: proof-of-key purposes and security notices exist
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ select * from public.create_key_challenge('add_credential') $$, 'W2: a proof-of-key challenge for adding a credential');
select lives_ok($$ select * from public.create_key_challenge('rotate_identity') $$, 'K2: a proof-of-key challenge for a key change');
select pg_temp.su();
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('alice'), pg_temp.uid('alice'), 'security_notice', 'profile', pg_temp.uid('alice')) $$,
  'W2: the server can notify every device of a new sign-in method');
select lives_ok($$ insert into public.notice_emails (kind, ref_id, user_id) values ('credential_added', gen_random_uuid(), pg_temp.uid('alice')) $$,
  'W2: and record the notice email');
select pg_temp.login('mallory');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('alice'), pg_temp.uid('mallory'), 'security_notice', 'profile', pg_temp.uid('alice')) $$,
  '42501', null, 'users cannot send security notices to others');

select * from finish();
rollback;
