-- Transparency (20261024000900_transparency.sql): the data map classifies EVERY column of every table
-- (a new migration that adds an unclassified column fails here), the live report returns only the
-- caller's rows, and account deletion leaves nothing the report counted. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- ---------------------------------------------------------------------------------------------
-- The map is complete and current
-- ---------------------------------------------------------------------------------------------
create temp view unmapped_tables as
  select t.table_schema || '.' || t.table_name as name
    from information_schema.tables t
   where t.table_schema in ('public', 'kw') and t.table_type = 'BASE TABLE'
     and not exists (select 1 from kw.data_map_tables m where m.table_name = t.table_schema || '.' || t.table_name);

create temp view unclassified_columns as
  select c.table_schema || '.' || c.table_name || '.' || c.column_name as name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
   where c.table_schema in ('public', 'kw')
     and not exists (select 1 from kw.data_map_columns d
                      where d.table_name = c.table_schema || '.' || c.table_name and d.column_name = c.column_name);

select is((select coalesce(array_agg(name order by name), '{}') from unmapped_tables), '{}'::text[],
  'every table in public and kw is in kw.data_map_tables (add new tables to the map in your migration)');
select is((select coalesce(array_agg(name order by name), '{}') from unclassified_columns), '{}'::text[],
  'every column is classified in kw.data_map_columns as id / time / plaintext / ciphertext / hashed');
select is((select coalesce(array_agg(d.table_name || '.' || d.column_name order by 1), '{}') from kw.data_map_columns d
            where not exists (select 1 from information_schema.columns c
                               where c.table_schema || '.' || c.table_name = d.table_name and c.column_name = d.column_name)),
  '{}'::text[], 'no stale classifications for columns that no longer exist');
select is((select coalesce(array_agg(m.table_name order by 1), '{}') from kw.data_map_tables m where to_regclass(m.table_name) is null),
  '{}'::text[], 'no stale tables in the map');

-- Sealed / envelope columns must be classified as ciphertext (a typo here would understate encryption
-- or, worse, claim plaintext is encrypted).
select is((select coalesce(array_agg(d.table_name || '.' || d.column_name order by 1), '{}') from kw.data_map_columns d
            where d.column_name in ('envelope', 'sealed', 'name_enc', 'enc', 'stored_envelope', 'amk_wrap', 'bundle', 'blob')
              and d.class <> 'ciphertext'),
  '{}'::text[], 'envelope / sealed / wrapped columns are classified as ciphertext');
select is((select coalesce(array_agg(d.table_name || '.' || d.column_name order by 1), '{}') from kw.data_map_columns d
            where d.class = 'ciphertext'
              and (select c.data_type from information_schema.columns c
                    where c.table_schema || '.' || c.table_name = d.table_name and c.column_name = d.column_name) not in ('jsonb', 'text')),
  '{}'::text[], 'ciphertext columns are jsonb envelopes or text blobs');
select ok((select count(*) from kw.data_map_tables where owner_pred is not null) >= 40, 'the map knows which rows belong to a person');
select ok(not has_table_privilege('authenticated', 'kw.data_map_columns', 'select'), 'the map tables are not directly readable');

-- Every reference to an account is removed with it (full delete, docs/v2/01-accounts.md §4).
select is((select coalesce(array_agg(c.conrelid::regclass::text || '.' || c.conname order by 1), '{}') from pg_constraint c
            where c.contype = 'f' and c.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
              and c.connamespace in ('public'::regnamespace, 'kw'::regnamespace) and c.confdeltype not in ('c', 'n')),
  '{}'::text[], 'every foreign key to an account cascades or is cleared on delete');
select ok(exists (select 1 from pg_constraint where conname = 'rate_events_user_fk' and confdeltype = 'c'),
  'rate-limit counters are deleted with the account');
select ok(exists (select 1 from cron.job where jobname = 'kithwall-transparency-maintenance'), 'old rate-limit counters are cleaned up');

-- ---------------------------------------------------------------------------------------------
-- The function
-- ---------------------------------------------------------------------------------------------
select ok((select prosecdef from pg_proc where oid = 'public.transparency_report()'::regprocedure), 'report is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.transparency_report()'::regprocedure), 'report pins search_path');
select ok(not has_function_privilege('anon', 'public.transparency_report()', 'execute'), 'anon cannot run the report');
select ok(has_function_privilege('authenticated', 'public.transparency_report()', 'execute'), 'signed-in users can');
select ok(has_function_privilege('anon', 'public.transparency_data_map()', 'execute'), 'the static data map is public');
select ok(not exists (select 1 from jsonb_array_elements(public.transparency_data_map()) x where x->>'table' like 'kw.data_map%'),
  'the public map leaves out service tables');

-- ---------------------------------------------------------------------------------------------
-- Fixtures: Alice (passkey-style synthetic email) and Bob (real email). They are connected; Bob has
-- blocked Carol; Carol has blocked Alice. Each has posts, comments and a stored file.
-- ---------------------------------------------------------------------------------------------
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000071a1'), ('bob', '00000000-0000-0000-0000-0000000071b0'),
  ('carol', '00000000-0000-0000-0000-0000000071c0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role, last_sign_in_at) values
  ('00000000-0000-0000-0000-0000000071a1', 'u000000000000000000000000000071a1@id.kithwall.invalid', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000071b0', 'bob-trans@test.local', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000071c0', 'carol-trans@test.local', 'authenticated', 'authenticated', now());
insert into public.profiles (id, username, sign_pub, kx_pub) select id, name || 'trans', repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.rows_in(r jsonb, tbl text) returns bigint language sql as $$
  select (x->>'rows')::bigint from jsonb_array_elements(r->'tables') x where x->>'table' = tbl $$;
grant execute on all functions in schema pg_temp to authenticated;

insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid('alice'), pg_temp.uid('bob')), greatest(pg_temp.uid('alice'), pg_temp.uid('bob')), 'accepted', pg_temp.uid('alice'), now());
insert into public.blocks (blocker, blocked) values (pg_temp.uid('bob'), pg_temp.uid('carol')), (pg_temp.uid('carol'), pg_temp.uid('alice'));
insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope, created_at)
  select gen_random_uuid(), pg_temp.uid('alice'), pg_temp.uid('alice'), 'status', false,
         (select a.id from public.audiences a where a.owner_id = pg_temp.uid('alice') and a.kind = 'friends'), 1, '{"c":"x"}',
         now() - (g || ' days')::interval
    from generate_series(1, 2) g;
insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  select gen_random_uuid(), pg_temp.uid('bob'), pg_temp.uid('bob'), 'status', false,
         (select a.id from public.audiences a where a.owner_id = pg_temp.uid('bob') and a.kind = 'friends'), 1, '{"c":"y"}'
    from generate_series(1, 3);
insert into public.media_objects (path, owner_id, bytes) values
  (pg_temp.uid('alice') || '/' || gen_random_uuid(), pg_temp.uid('alice'), 1000), (pg_temp.uid('alice') || '/' || gen_random_uuid(), pg_temp.uid('alice'), 500),
  (pg_temp.uid('bob') || '/' || gen_random_uuid(), pg_temp.uid('bob'), 7777);
insert into public.account_security (user_id, notice_email, notice_email_verified_at) values (pg_temp.uid('bob'), 'bob-notices@test.local', now());

-- ---------------------------------------------------------------------------------------------
-- Only the caller's rows
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
select throws_ok($$ select public.transparency_report() $$, '42501', 'sign in first', 'no report without a signed-in caller');

select pg_temp.login('alice');
create temp table rep_alice as select public.transparency_report() as r;
select pg_temp.login('bob');
create temp table rep_bob as select public.transparency_report() as r;
select pg_temp.su();

select is((select r->'account'->>'user_id' from rep_alice), pg_temp.uid('alice')::text, 'the report is about the caller');
select is((select r->'account'->>'email_kind' from rep_alice), 'synthetic', 'a passkey account is reported as having a made-up address');
select is((select r->'account'->>'email' from rep_alice), null, '…and no real email');
select is((select r->'account'->>'email_kind' from rep_bob), 'real', 'a v1 account is reported with its real email');
select is((select r->'account'->>'notice_email' from rep_bob), 'bob-notices@test.local', 'the notice email is shown to its owner');
select is((select pg_temp.rows_in(r, 'public.posts') from rep_alice), 2::bigint, 'Alice: 2 posts');
select is((select pg_temp.rows_in(r, 'public.posts') from rep_bob), 3::bigint, 'Bob: 3 posts');
select is((select pg_temp.rows_in(r, 'public.friendships') from rep_alice), 1::bigint, 'the connection counts for both people');
select is((select pg_temp.rows_in(r, 'public.blocks') from rep_alice), 0::bigint, 'being blocked by someone is never revealed');
select is((select pg_temp.rows_in(r, 'public.blocks') from rep_bob), 1::bigint, 'blocks you made are counted');
select is((select (x->>'bytes')::numeric from rep_alice, jsonb_array_elements(r->'tables') x where x->>'table' = 'public.media_objects'),
  1500::numeric, 'file sizes add up to the caller''s own files');
select ok((select r::text not like '%' || pg_temp.uid('bob') || '%' and r::text not like '%bobtrans%' and r::text not like '%' || pg_temp.uid('carol') || '%' from rep_alice),
  'Alice''s report names no one else (no ids, no handles)');
select ok((select r::text not like '%bob-notices%' from rep_alice), 'Bob''s notice email is not in Alice''s report');
select is((select r->'tables'->0->'columns' ? 'id' or r->'tables'->0->'columns' ? 'time' from rep_alice), true, 'each table lists its column classes');
select is((select x->'columns'->'ciphertext' from rep_alice, jsonb_array_elements(r->'tables') x where x->>'table' = 'public.posts'),
  '["envelope"]'::jsonb, 'posts: the envelope is ciphertext');
select ok((select (x->'columns'->'time') ? 'created_at' from rep_alice, jsonb_array_elements(r->'tables') x where x->>'table' = 'public.posts'),
  'posts: the time is visible');
select ok((select (x->>'first')::timestamptz <= (x->>'last')::timestamptz from rep_alice, jsonb_array_elements(r->'tables') x where x->>'table' = 'public.posts'),
  'first and last times are reported');
select ok((select not exists (select 1 from jsonb_array_elements(r->'tables') x where x->>'category' = 'system') from rep_alice),
  'service tables are not reported as data about you');

-- ---------------------------------------------------------------------------------------------
-- Deleting the account leaves nothing the report counts (crypto-shredding: keys go with it)
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('alice');
select lives_ok($$ select public.transparency_report() $$, 'the report runs');
select pg_temp.su();
insert into kw.rate_events (user_id, action) values (pg_temp.uid('alice'), 'test');
delete from auth.users where id = pg_temp.uid('alice');
select pg_temp.login('alice');
select is((select coalesce(sum((x->>'rows')::bigint), 0) from jsonb_array_elements(public.transparency_report()->'tables') x),
  0::numeric, 'after deletion no table holds a row about the account');
select pg_temp.su();
select is((select count(*) from kw.rate_events where user_id = pg_temp.uid('alice')), 0::bigint, 'rate-limit counters went with it');

select * from finish();
rollback;
