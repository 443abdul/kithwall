-- Key transparency (20261102000500_key_transparency.sql, docs/v2/09-key-transparency.md): the Merkle log
-- hashes exactly like packages/crypto (shared vectors), every key publication appends a leaf and a head,
-- nothing can rewrite the log, openings are only for people who may see the profile and go with the
-- account while the leaf stays. The log is shared and already holds every existing account, so the
-- checks are relative to its size when the test starts. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- ---------------------------------------------------------------------------------------------
-- Hashing: RFC 6962 test data and the commitment vector from packages/crypto/test/kt.test.ts
-- ---------------------------------------------------------------------------------------------
create temp table rfc (i int primary key, h bytea);
insert into rfc select i, sha256('\x00'::bytea || decode(d, 'hex'))
  from unnest(array['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'])
       with ordinality as t(d, i);
select is(encode(kw.kt_mth_of(array(select h from rfc where i <= 1 order by i)), 'hex'),
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d', 'RFC 6962 root of 1 leaf');
select is(encode(kw.kt_mth_of(array(select h from rfc where i <= 3 order by i)), 'hex'),
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77', 'RFC 6962 root of 3 leaves');
select is(encode(kw.kt_mth_of(array(select h from rfc where i <= 5 order by i)), 'hex'),
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4', 'RFC 6962 root of 5 leaves');
select is(encode(kw.kt_mth_of(array(select h from rfc where i <= 8 order by i)), 'hex'),
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328', 'RFC 6962 root of 8 leaves');
select is(encode(kw.kt_mth_of('{}'), 'hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty tree');

select is(encode(kw.kt_commitment('0f9c3f1e-6a4b-4c2d-9e8f-1a2b3c4d5e6f', 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI', 3, '\x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'), 'hex'),
  'acebae685411a51be34974f33ccf0b8b72fa57199ca8e18c8d6128525ec70c84', 'commitment matches the packages/crypto vector');
select is(encode(kw.kt_leaf_hash(decode('acebae685411a51be34974f33ccf0b8b72fa57199ca8e18c8d6128525ec70c84', 'hex')), 'hex'),
  'ac04dc149d0f0605f90f64a92136adbc5a53616792fc47153f18c1150ce9d42a', 'leaf hash matches the packages/crypto vector');
select is(kw.kt_b64u('\xfbff'::bytea), '-_8', 'base64url without padding');

-- An independent RFC 9162 §2.1.3.2 verifier, to check the proofs the server hands out.
create function pg_temp.root_from_path(leaf bytea, idx bigint, size bigint, path text[]) returns bytea language plpgsql as $$
declare fn bigint := idx; sn bigint := size - 1; r bytea := leaf; p text; b bytea;
begin
  if idx >= size then return null; end if;
  foreach p in array coalesce(path, '{}') loop
    if sn = 0 then return null; end if;
    b := decode(translate(p, '-_', '+/') || repeat('=', (4 - length(p) % 4) % 4), 'base64');
    if fn % 2 = 1 or fn = sn then
      r := sha256('\x01'::bytea || b || r);
      while fn % 2 = 0 and fn <> 0 loop fn := fn / 2; sn := sn / 2; end loop;
    else
      r := sha256('\x01'::bytea || r || b);
    end if;
    fn := fn / 2; sn := sn / 2;
  end loop;
  if sn <> 0 then return null; end if;
  return r;
end $$;
create function pg_temp.unb64u(s text) returns bytea language sql as $$
  select decode(translate(s, '-_', '+/') || repeat('=', (4 - length(s) % 4) % 4), 'base64')
$$;

-- ---------------------------------------------------------------------------------------------
-- The stored tree: backfill, roots, append on sign-up and on a signed key change
-- ---------------------------------------------------------------------------------------------
create temp table start as select coalesce(max(size), 0) as n from kw.kt_heads;
select ok((select n from start) >= (select count(*) from public.profiles), 'every existing account was logged at migration time');
select is((select count(*)::int from public.profiles p where not exists (
            select 1 from kw.kt_openings o where o.user_id = p.id and o.sign_pub = p.sign_pub and o.kx_pub = p.kx_pub
              and o.key_version = p.key_version)), 0, 'every profile''s current keys have an opening');
select is((select count(*)::int from kw.kt_openings o join kw.kt_leaves l on l.idx = o.leaf_idx
            where l.commitment <> kw.kt_commitment(o.user_id, o.sign_pub, o.kx_pub, o.key_version, o.salt)), 0,
  'every opening opens its leaf');
select is(kw.kt_mth(0, (select n from start)), kw.kt_mth_of(array(select hash from kw.kt_nodes where level = 0 order by idx)),
  'the root from stored subtrees equals the root recomputed from all leaf hashes');
select is((select root from kw.kt_heads where size = (select n from start)), kw.kt_mth(0, (select n from start)), 'the latest head is that root');
select is((select count(*)::bigint from kw.kt_heads), (select n from start), 'one head per entry');

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000082a1'), ('bob', '00000000-0000-0000-0000-0000000082b0'),
  ('stranger', '00000000-0000-0000-0000-0000000082c0');
grant select on ids, start to authenticated, anon;
insert into auth.users (id, email, aud, role) select id, name || '-kt@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'kt', repeat(upper(left(name, 1)), 43), repeat(lower(left(name, 1)), 43) from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now() from ids a, ids b where a.name = 'alice' and b.name = 'bob';

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select is((select max(size) from kw.kt_heads), (select n from start) + 3, 'three sign-ups appended three leaves and three heads');
select is((select leaf_idx from kw.kt_openings where user_id = pg_temp.uid('alice')), (select n from start),
  'Alice''s key is the next entry');
select is((select key_version from kw.kt_openings where user_id = pg_temp.uid('bob')), 1, 'a new account publishes key version 1');
select is((select root from kw.kt_heads where size = (select n from start) + 3),
  kw.kt_mth_of(array(select hash from kw.kt_nodes where level = 0 order by idx)), 'the new head''s root is right');

-- Bob rotates his key (the signed change; the route verified the signatures).
insert into public.key_bundles (user_id, bundle) values (pg_temp.uid('bob'), '{"v":1}');
set local role service_role;
select is(public.apply_identity_key_change(pg_temp.uid('bob'),
  jsonb_build_object('userId', pg_temp.uid('bob'), 'oldSignPub', repeat('B', 43), 'newSignPub', repeat('Z', 43), 'newKxPub', repeat('Y', 43), 'at', 'now'),
  repeat('S', 86), jsonb_build_object('v', 1, 'signPub', repeat('Z', 43), 'kxPub', repeat('Y', 43))), 2, 'Bob rotates his identity key');
select pg_temp.su();
select is((select max(size) from kw.kt_heads), (select n from start) + 4, 'the rotation appended a leaf');
select is((select key_version || ':' || sign_pub from kw.kt_openings where user_id = pg_temp.uid('bob') order by leaf_idx desc limit 1),
  '2:' || repeat('Z', 43), 'the new key is logged as version 2');
select is((select count(*)::int from kw.kt_openings where user_id = pg_temp.uid('bob')), 2, 'the old publication stays in the log');
update public.profiles set discoverable = true where id = pg_temp.uid('stranger');
select is((select max(size) from kw.kt_heads), (select n from start) + 4, 'other profile changes log nothing');
update public.profiles set discoverable = false where id = pg_temp.uid('stranger');

-- ---------------------------------------------------------------------------------------------
-- Nothing can rewrite the log
-- ---------------------------------------------------------------------------------------------
select throws_ok($$ update kw.kt_leaves set commitment = sha256('x') where idx = 0 $$, '42501', null, 'the owner cannot edit a leaf');
select throws_ok($$ delete from kw.kt_leaves where idx = (select max(idx) from kw.kt_leaves) $$, '42501', null, 'the owner cannot delete a leaf');
select throws_ok($$ truncate kw.kt_heads cascade $$, '42501', null, 'nor truncate the heads');
select throws_ok($$ update kw.kt_nodes set hash = sha256('x') where level = 0 and idx = 0 $$, '42501', null, 'nor edit a node');
select throws_ok($$ delete from kw.kt_heads where size = (select max(size) from kw.kt_heads) $$, '42501', null, 'nor delete a head');
select throws_ok($$ update kw.kt_openings set salt = sha256('x') where user_id = pg_temp.uid('alice') $$, '42501', null, 'nor edit an opening');
select throws_ok($$ insert into kw.kt_leaves (idx, commitment) values (0, sha256('x')) $$, null, null, 'a leaf cannot be inserted out of order');
select throws_ok($$ insert into kw.kt_heads (size, root) values (1, sha256('x')) $$, null, null, 'a head cannot be re-issued for an old size');
set local role service_role;
select throws_ok($$ delete from kw.kt_leaves $$, '42501', null, 'the service role has no access to the log tables');
select throws_ok($$ insert into kw.kt_leaves (idx, commitment) values ((select max(idx) + 1 from kw.kt_leaves), sha256('x')) $$, '42501', null,
  'the service role cannot append a leaf of its own');
select throws_ok($$ select kw.kt_publish(pg_temp.uid('alice'), repeat('Q', 43), repeat('Q', 43), 9) $$, '42501', null,
  'the service role cannot call the append function');
select pg_temp.su();
select pg_temp.login('alice');
select throws_ok($$ select * from kw.kt_openings $$, '42501', null, 'users cannot read openings directly');
select throws_ok($$ select kw.kt_publish(pg_temp.uid('alice'), repeat('Q', 43), repeat('Q', 43), 9) $$, '42501', null,
  'users cannot append');
select pg_temp.su();

-- ---------------------------------------------------------------------------------------------
-- Public reads: head and consistency (anyone), inclusion (signed in, visibility rules)
-- ---------------------------------------------------------------------------------------------
set local role anon;
select is((select size from public.kt_head()), (select n from start) + 4, 'anyone reads the latest head');
select ok((select pg_temp.unb64u(root) from public.kt_head((select n from start) + 1)) is not null, 'and any earlier head by size');
select is(cardinality(public.kt_consistency((select n from start) + 4, (select n from start) + 4)), 0, 'consistency of a size with itself is empty');
select throws_ok($$ select public.kt_consistency(5, 3) $$, '22023', null, 'a shrinking range is refused');
select throws_ok($$ select public.kt_consistency(1, (select n + 99 from start)) $$, '22023', null, 'sizes beyond the log are refused');
select throws_ok($$ select * from public.kt_inclusion(null, '[]') $$, '42501', null, 'inclusion proofs need a signed-in user');
select pg_temp.su();

-- Consistency proofs from every earlier size verify against the RFC 9162 algorithm (checked in TypeScript
-- by the client; here: the proof from size n to n+4 recomputes both roots).
create function pg_temp.consistent(m bigint, n bigint) returns boolean language plpgsql as $$
declare proof text[] := public.kt_consistency(m, n); path bytea[] := '{}'; fn bigint := m - 1; sn bigint := n - 1;
        fr bytea; sr bytea; c bytea; i int; pow2 boolean := (m & (m - 1)) = 0;
begin
  if m = n then return cardinality(proof) = 0; end if;
  if pow2 then path := array[(select root from kw.kt_heads where size = m)]; end if;
  for i in 1 .. coalesce(cardinality(proof), 0) loop path := path || pg_temp.unb64u(proof[i]); end loop;
  while fn % 2 = 1 loop fn := fn / 2; sn := sn / 2; end loop;
  fr := path[1]; sr := path[1];
  for i in 2 .. coalesce(cardinality(path), 0) loop
    c := path[i];
    if sn = 0 then return false; end if;
    if fn % 2 = 1 or fn = sn then
      fr := sha256('\x01'::bytea || c || fr); sr := sha256('\x01'::bytea || c || sr);
      while fn % 2 = 0 and fn <> 0 loop fn := fn / 2; sn := sn / 2; end loop;
    else
      sr := sha256('\x01'::bytea || sr || c);
    end if;
    fn := fn / 2; sn := sn / 2;
  end loop;
  return sn = 0 and fr = (select root from kw.kt_heads where size = m) and sr = (select root from kw.kt_heads where size = n);
end $$;
select ok(pg_temp.consistent((select n from start), (select n from start) + 4), 'consistency proof from the start size verifies');
select ok(pg_temp.consistent(1, (select n from start) + 4), 'consistency proof from size 1 verifies');
select ok((select bool_and(pg_temp.consistent(m, (select n from start) + 4)) from generate_series(greatest(1, (select n from start) - 20), (select n from start) + 3) m),
  'consistency proofs from the last 24 sizes verify');

select pg_temp.login('alice');
create temp table incl as
  select * from public.kt_inclusion(null, jsonb_build_array(
    jsonb_build_object('user', pg_temp.uid('bob'), 'signPub', repeat('Z', 43), 'kxPub', repeat('Y', 43)),
    jsonb_build_object('user', pg_temp.uid('bob'), 'signPub', repeat('Q', 43), 'kxPub', repeat('Y', 43)),
    jsonb_build_object('user', pg_temp.uid('stranger'), 'signPub', repeat('S', 43), 'kxPub', repeat('s', 43)),
    jsonb_build_object('user', pg_temp.uid('alice'), 'signPub', repeat('A', 43), 'kxPub', repeat('a', 43))));
select pg_temp.su();
select is((select array_agg(status order by ord) from (select status, row_number() over () as ord from incl) x),
  array['ok', 'missing', 'hidden', 'ok'], 'a friend''s key: ok; keys they never published: missing; a stranger: hidden; myself: ok');
select is((select salt from incl where user_id = pg_temp.uid('stranger')), null, 'nothing about a hidden profile is revealed');
select is((select salt from incl where status = 'missing'), null, 'nor about missing keys');
select is((select pg_temp.root_from_path(kw.kt_leaf_hash(kw.kt_commitment(user_id, repeat('Z', 43), repeat('Y', 43), key_version, pg_temp.unb64u(salt))),
            leaf_index, (select n from start) + 4, proof) from incl where user_id = pg_temp.uid('bob') and status = 'ok'),
  (select root from kw.kt_heads where size = (select n from start) + 4), 'Bob''s opening and audit path lead to the head');
select is((select key_version from incl where user_id = pg_temp.uid('bob') and status = 'ok'), 2, 'for his current key version');

select pg_temp.login('alice');
select is((select status from public.kt_inclusion((select n from start) + 2,
            jsonb_build_array(jsonb_build_object('user', pg_temp.uid('bob'), 'signPub', repeat('Z', 43), 'kxPub', repeat('Y', 43))))),
  'later', 'a key logged after the requested size says so');
create temp table incl_old as select * from public.kt_inclusion((select n from start) + 2,
  jsonb_build_array(jsonb_build_object('user', pg_temp.uid('alice'), 'signPub', repeat('A', 43), 'kxPub', repeat('a', 43))));
select throws_ok($$ select * from public.kt_inclusion((select n + 99 from start), '[]') $$, '22023', null, 'a size beyond the log is refused');
select throws_ok($$ select * from public.kt_inclusion(null, (select jsonb_agg(jsonb_build_object('user', pg_temp.uid('bob'))) from generate_series(1, 51))) $$,
  '22023', null, 'at most 50 people per request');
select throws_ok($$ select * from public.kt_inclusion(null, '[{"user":"not-a-uuid"}]') $$, '22023', null, 'malformed entries are refused');
select pg_temp.su();
select is((select pg_temp.root_from_path(kw.kt_leaf_hash(kw.kt_commitment(pg_temp.uid('alice'), repeat('A', 43), repeat('a', 43), 1, pg_temp.unb64u(salt))),
            leaf_index, (select n from start) + 2, proof) from incl_old),
  (select root from kw.kt_heads where size = (select n from start) + 2), 'proofs against an older head work too');

-- Blocking hides the opening like the profile.
insert into public.blocks (blocker, blocked) values (pg_temp.uid('bob'), pg_temp.uid('alice'));
select pg_temp.login('alice');
select is((select status from public.kt_inclusion(null, jsonb_build_array(jsonb_build_object('user', pg_temp.uid('bob'), 'signPub', repeat('Z', 43), 'kxPub', repeat('Y', 43))))),
  'hidden', 'someone who blocked me is hidden');
select pg_temp.su();

-- ---------------------------------------------------------------------------------------------
-- Account deletion: the opening goes, the leaf (and every head) stays
-- ---------------------------------------------------------------------------------------------
create temp table before_delete as select max(size) as n, (select root from kw.kt_heads order by size desc limit 1) as root from kw.kt_heads;
delete from auth.users where id = pg_temp.uid('bob');
select is((select count(*)::int from kw.kt_openings where user_id = pg_temp.uid('bob')), 0, 'deleting an account deletes its openings');
select is((select max(size) from kw.kt_heads), (select n from before_delete), 'the log keeps its size');
select is((select root from kw.kt_heads order by size desc limit 1), (select root from before_delete), 'and its root');
select is((select count(*)::bigint from kw.kt_leaves), (select n from before_delete), 'every leaf is still there');

select * from finish();
rollback;
