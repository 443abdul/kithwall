-- Kithwall 2 passkeys: account creation RPC, RLS on credentials / wraps / account facts, the
-- single-use challenge store, counters, and the "never remove the last way to unlock" rule.
-- Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('pia', '00000000-0000-0000-0000-00000000a001'),   -- passkey-only account
  ('pat', '00000000-0000-0000-0000-00000000a002'),   -- passphrase account
  ('leo', '00000000-0000-0000-0000-00000000a003'),   -- v1 (legacy) account with a password wrap
  ('eve', '00000000-0000-0000-0000-00000000a004');   -- someone else
grant select on ids to authenticated;
insert into auth.users (id, email, aud, role)
  select id, name || '-pk@id.kithwall.invalid', 'authenticated', 'authenticated' from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.bundle(sign text, pw boolean) returns jsonb language sql as $$
  select jsonb_build_object('v', 1, 'kdf', jsonb_build_object('alg', 'argon2id', 'v', 1, 'm', 65536, 't', 3, 'p', 1),
    'signPub', sign, 'kxPub', repeat('K', 43), 'amkByRecovery', 'rec', 'identityEnc', 'idn', 'rkCommitment', 'com')
    || case when pw then jsonb_build_object('amkByPassword', 'pwwrap') else '{}'::jsonb end
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- Server-only RPCs are not callable by clients
-- ---------------------------------------------------------------------------------------
select pg_temp.login('eve');
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('eve'), 'evehandle', pg_temp.bundle(repeat('E', 43), true)) $$,
  '42501', null, 'clients cannot call create_passkey_account');
select throws_ok($$ select * from public.consume_webauthn_challenge(gen_random_uuid(), 'login') $$, '42501', null,
  'clients cannot consume challenges');
select throws_ok($$ select public.passkey_used('x', 1, false) $$, '42501', null, 'clients cannot bump counters');
select throws_ok($$ select * from public.webauthn_challenges $$, '42501', null, 'challenge store is server-only');
select throws_ok($$ select * from public.passkey_users $$, '42501', null, 'WebAuthn user handles are server-only');
select throws_ok($$ select * from public.notice_email_verifications $$, '42501', null, 'verification links are server-only');
select pg_temp.su();

-- ---------------------------------------------------------------------------------------
-- Account creation (service role)
-- ---------------------------------------------------------------------------------------
select pg_temp.service();
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('pia'), 'piahandle', pg_temp.bundle(repeat('P', 43), false)) $$,
  '22023', null, 'a bundle without a password wrap needs a passkey wrap');
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('pia'), 'piahandle', '{"v":1}'::jsonb) $$,
  '22023', null, 'malformed bundles are refused');
select lives_ok($$ select public.create_passkey_account(pg_temp.uid('pia'), 'PiaHandle', pg_temp.bundle(repeat('P', 43), false),
  repeat('w', 43), 'cred-pia-0000000001', repeat('k', 80), 0, '{internal,hybrid}', true, 'This phone',
  repeat('s', 43), repeat('x', 98)) $$, 'creates a passkey account in one step');
select lives_ok($$ select public.create_passkey_account(pg_temp.uid('pat'), 'pathandle', pg_temp.bundle(repeat('Q', 43), true)) $$,
  'creates a passphrase account (no passkey)');
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('eve'), 'piahandle', pg_temp.bundle(repeat('E', 43), true)) $$,
  '23505', null, 'a taken handle is refused (case-insensitively)');
select is((select count(*)::int from public.key_bundles where user_id = pg_temp.uid('eve')), 0, 'a failed creation leaves no key bundle');
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('eve'), 'settings', pg_temp.bundle(repeat('E', 43), true)) $$,
  '23514', null, 'reserved handles are refused');
select throws_ok($$ select public.create_passkey_account(pg_temp.uid('eve'), 'x_', pg_temp.bundle(repeat('E', 43), true)) $$,
  '23514', null, 'invalid handles are refused');
select pg_temp.su();

select is((select username::text from public.profiles where id = pg_temp.uid('pia')), 'piahandle', 'profile stores the handle lower-cased');
select is((select sign_pub from public.profiles where id = pg_temp.uid('pia')), repeat('P', 43), 'profile public keys come from the bundle');
select is((select count(*)::int from public.audiences where owner_id = pg_temp.uid('pia')), 2, 'default audiences are created');
select is((select count(*)::int from public.passkey_wraps where user_id = pg_temp.uid('pia')), 1, 'the passkey wrap is stored');
select ok(exists (select 1 from public.account_security where user_id = pg_temp.uid('pat')), 'account facts row exists');

-- Legacy account: profile + password bundle as v1 made them.
insert into public.key_bundles (user_id, bundle) values (pg_temp.uid('leo'), pg_temp.bundle(repeat('L', 43), true));
insert into public.profiles (id, username, sign_pub, kx_pub) values (pg_temp.uid('leo'), 'leohandle', repeat('L', 43), repeat('K', 43));
insert into public.profiles (id, username, sign_pub, kx_pub) values (pg_temp.uid('eve'), 'evehandle', repeat('E', 43), repeat('K', 43));

-- ---------------------------------------------------------------------------------------
-- RLS: owner-only reads, no client writes
-- ---------------------------------------------------------------------------------------
select pg_temp.login('pia');
select is((select count(*)::int from public.passkeys), 1, 'owner sees their passkey');
select is((select count(*)::int from public.passkey_wraps), 1, 'owner sees their passkey wrap');
select is((select count(*)::int from public.account_security), 1, 'owner sees their account facts');
select throws_ok($$ insert into public.passkeys (user_id, credential_id, public_key) values (auth.uid(), 'cred-forged-000001', repeat('k', 40)) $$,
  '42501', null, 'clients cannot insert passkeys');
select throws_ok($$ update public.passkey_wraps set amk_wrap = repeat('y', 98) $$, '42501', null, 'clients cannot change wraps');
select throws_ok($$ update public.account_security set recovery_saved_at = now() $$, '42501', null,
  'clients cannot set account facts directly');
select throws_ok($$ delete from public.passkeys $$, '42501', null, 'clients cannot delete passkeys directly');
select pg_temp.login('eve');
select is((select count(*)::int from public.passkeys), 0, 'others do not see the passkey');
select is((select count(*)::int from public.passkey_wraps), 0, 'others do not see the wrap');
select is((select count(*)::int from public.account_security), 0, 'others do not see account facts');
select pg_temp.su();
set local role anon;
select throws_ok($$ select * from public.passkeys $$, '42501', null, 'anon cannot read passkeys');
reset role;

-- ---------------------------------------------------------------------------------------
-- Challenges: single use, intent-bound, expiring; rate-limit counter
-- ---------------------------------------------------------------------------------------
insert into public.webauthn_challenges (id, intent, challenge, ip_tag) values
  ('00000000-0000-0000-0000-0000000c0001', 'login', repeat('c', 43), repeat('a', 32)),
  ('00000000-0000-0000-0000-0000000c0002', 'login', repeat('d', 43), repeat('a', 32));
insert into public.webauthn_challenges (id, intent, challenge, expires_at) values
  ('00000000-0000-0000-0000-0000000c0003', 'login', repeat('e', 43), now() - interval '1 second');
select throws_ok($$ insert into public.webauthn_challenges (intent, challenge) values ('add', repeat('f', 43)) $$,
  '23514', null, 'an add challenge must be bound to a user');
select throws_ok($$ insert into public.webauthn_challenges (intent, challenge, new_user_id) values ('register', repeat('f', 43), gen_random_uuid()) $$,
  '23514', null, 'a register challenge must carry the handle');
select pg_temp.service();
select is((select count(*)::int from public.consume_webauthn_challenge('00000000-0000-0000-0000-0000000c0001', 'add')), 0,
  'a challenge cannot be used for another intent');
select is((select challenge from public.consume_webauthn_challenge('00000000-0000-0000-0000-0000000c0001', 'login')), repeat('c', 43),
  'a challenge is consumed once');
select is((select count(*)::int from public.consume_webauthn_challenge('00000000-0000-0000-0000-0000000c0001', 'login')), 0,
  'a consumed challenge cannot be replayed');
select is((select count(*)::int from public.consume_webauthn_challenge('00000000-0000-0000-0000-0000000c0003', 'login')), 0,
  'an expired challenge cannot be used');
select is(public.webauthn_recent_challenges(repeat('a', 32), 'login', 600), 2, 'recent challenges are counted per client tag');
select is(public.webauthn_recent_challenges(repeat('b', 32), 'login', 600), 0, 'other clients are counted separately');

-- ---------------------------------------------------------------------------------------
-- Counters
-- ---------------------------------------------------------------------------------------
select is(public.passkey_used('cred-pia-0000000001', 0, true), pg_temp.uid('pia'), 'a non-counting authenticator signs in');
select lives_ok($$ select public.add_passkey(pg_temp.uid('pia'), repeat('w', 43), 'cred-pia-0000000002', repeat('k', 80), 5,
  '{usb}', false, 'Security key', repeat('t', 43), repeat('z', 98)) $$, 'a second passkey can be added');
select is(public.passkey_used('cred-pia-0000000002', 6, false), pg_temp.uid('pia'), 'the counter moves forward');
select throws_ok($$ select public.passkey_used('cred-pia-0000000002', 6, false) $$, '22023', null,
  'a repeated counter (cloned authenticator) is refused');
select throws_ok($$ select public.add_passkey(pg_temp.uid('pia'), repeat('v', 43), 'cred-pia-0000000003', repeat('k', 80), 0,
  '{}', false, null, repeat('t', 43), repeat('z', 98)) $$, '22023', null, 'the WebAuthn user handle of an account is fixed');
select throws_ok($$ select public.add_passkey(pg_temp.uid('eve'), repeat('q', 43), 'cred-pia-0000000002', repeat('k', 80), 0,
  '{}', false, null, repeat('t', 43), repeat('z', 98)) $$, '23505', null, 'a credential belongs to one account only');
select pg_temp.su();

-- ---------------------------------------------------------------------------------------
-- remove_passkey: never the last way to unlock
-- ---------------------------------------------------------------------------------------
select pg_temp.login('pia');
select lives_ok($$ select public.remove_passkey((select id from public.passkeys where credential_id = 'cred-pia-0000000002')) $$,
  'removing one of two passkeys works');
select is((select count(*)::int from public.passkey_wraps), 1, 'its wrap is removed with it');
select throws_ok($$ select public.remove_passkey((select id from public.passkeys where credential_id = 'cred-pia-0000000001')) $$,
  'P0001', 'last unlock method', 'the only passkey of an account without fallback cannot be removed');
select pg_temp.login('eve');
select throws_ok($$ select public.remove_passkey((select id from public.passkeys limit 1)) $$, 'P0002', null,
  'others cannot remove my passkey (they cannot even see it)');
select pg_temp.su();
select throws_ok(format($$ select public.remove_passkey(%L) $$, (select id from public.passkeys where credential_id = 'cred-pia-0000000001')),
  '42501', null, 'anonymous callers are refused');
select pg_temp.login('pia');
select lives_ok($$ select public.mark_recovery_saved() $$, 'owner confirms the recovery phrase is saved');
select ok((select recovery_saved_at is not null from public.account_security), 'recovery_saved_at is set');
select lives_ok($$ select public.mark_recovery_saved(false) $$, 'rotating the phrase clears the flag first');
select throws_ok($$ select public.remove_passkey((select id from public.passkeys where credential_id = 'cred-pia-0000000001')) $$,
  'P0001', 'last unlock method', 'an unconfirmed (rotated) phrase does not count');
select lives_ok($$ select public.mark_recovery_saved() $$, 'the new phrase is confirmed');
select lives_ok($$ select public.remove_passkey((select id from public.passkeys where credential_id = 'cred-pia-0000000001')) $$,
  'with a saved recovery phrase the last passkey can be removed');
select pg_temp.su();

-- A legacy account (password wrap) may remove its only passkey.
select pg_temp.service();
select lives_ok($$ select public.add_passkey(pg_temp.uid('leo'), repeat('l', 43), 'cred-leo-0000000001', repeat('k', 80), 0,
  '{}', false, 'Laptop', repeat('t', 43), repeat('z', 98)) $$, 'a v1 account adds a passkey');
select pg_temp.su();
select pg_temp.login('leo');
select lives_ok($$ select public.remove_passkey((select id from public.passkeys limit 1)) $$,
  'an account with a password can remove its only passkey');
select pg_temp.su();

-- MFA: a TOTP-enrolled account on an aal1 session sees nothing and cannot remove passkeys.
select pg_temp.service();
select public.add_passkey(pg_temp.uid('leo'), repeat('l', 43), 'cred-leo-0000000002', repeat('k', 80), 0, '{}', false, null, repeat('t', 43), repeat('z', 98));
select pg_temp.su();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values (gen_random_uuid(), pg_temp.uid('leo'), 'app', 'totp', 'verified', now(), now());
select pg_temp.login('leo');
select is((select count(*)::int from public.passkeys), 0, 'aal1 session of an MFA account sees no passkeys');
select is((select count(*)::int from public.passkey_wraps), 0, 'aal1 session of an MFA account sees no wraps');
select throws_ok($$ select public.remove_passkey(gen_random_uuid()) $$, '42501', null, 'aal1 session cannot remove passkeys');
select pg_temp.su();

-- Deleting the auth user removes everything (crypto-shredding of the wraps).
delete from auth.users where id = pg_temp.uid('pia');
select is((select count(*)::int from public.passkeys where user_id = pg_temp.uid('pia')), 0, 'passkeys go with the account');
select is((select count(*)::int from public.passkey_users where user_id = pg_temp.uid('pia')), 0, 'WebAuthn handle goes with the account');

select * from finish();
rollback;
