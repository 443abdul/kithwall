-- Crash reports (20261112000400_crash_reports.sql): only the server writes them, only admins read them,
-- nothing in the table can name a person, the same bug groups together, a retried upload is stored once, the
-- daily cap holds, and reports are gone after 30 days. Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('admin', '00000000-0000-0000-0000-00000000c4a1'), ('mod', '00000000-0000-0000-0000-00000000c4b0'),
  ('member', '00000000-0000-0000-0000-00000000c4c0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-crash@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'crash', repeat('A', 43), repeat('B', 43) from ids;
insert into public.staff_roles (user_id, role) values
  ((select id from ids where name = 'admin'), 'admin'), ((select id from ids where name = 'mod'), 'moderator');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.anon() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', true); perform set_config('role', 'anon', true); end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.add(p_id uuid, p_fp text, p_name text default 'TypeError', p_version text default '2.5.0', p_max int default 2000)
returns boolean language sql as $$
  select public.crash_report_add(p_id, p_fp, 'error', 'android', '58a235e0c1d2', p_version, '412', 'Android 14', 'WebView 145',
    '/messages/[id]', 'ur', p_name, 'Cannot read properties of undefined (reading ''envelope'')',
    'at readMessage (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)', 'at Bubble', p_max)
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;
-- A shared development database may hold reports already; this test counts its own (rolled back at the end).
delete from public.crash_reports;

-- ---------------------------------------------------------------------------------------------
-- Shape: nothing here can point at a person
-- ---------------------------------------------------------------------------------------------
select is((select coalesce(array_agg(column_name::text order by 1), '{}') from information_schema.columns
            where table_schema = 'public' and table_name = 'crash_reports'
              and (data_type in ('inet', 'cidr') or column_name ~ '(user|account|owner|profile|session|device|ip|addr|agent|token|email|handle)')),
  '{}'::text[], 'no column for an account, session, device, IP address or user agent');
select is((select count(*)::int from pg_constraint where conrelid = 'public.crash_reports'::regclass and contype = 'f'), 0,
  'no foreign key: a report is linked to nothing');
select is((select category from kw.data_map_tables where table_name = 'public.crash_reports'), 'system', 'in the data map');
select is((select owner_pred from kw.data_map_tables where table_name = 'public.crash_reports'), null, 'the data map knows no row is about a person');
select is((select retention from kw.data_map_tables where table_name = 'public.crash_reports'), '30 days', 'retention is stated');

-- ---------------------------------------------------------------------------------------------
-- Writing: the server only
-- ---------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.crash_report_add(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, int)', 'execute'),
  'members cannot call crash_report_add');
select ok(not has_function_privilege('anon', 'public.crash_report_add(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, int)', 'execute'),
  'visitors cannot call crash_report_add');
select ok(has_function_privilege('service_role', 'public.crash_report_add(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, int)', 'execute'),
  'the server can');
select ok(not has_function_privilege('authenticated', 'public.prune_crash_reports()', 'execute'), 'members cannot prune');
select ok(not has_table_privilege('authenticated', 'public.crash_reports', 'insert')
      and not has_table_privilege('authenticated', 'public.crash_reports', 'update')
      and not has_table_privilege('authenticated', 'public.crash_reports', 'delete'), 'no direct writes for members');
select ok(not has_table_privilege('anon', 'public.crash_reports', 'select'), 'visitors cannot read the table');

select pg_temp.su();
select ok(pg_temp.add('10000000-0000-4000-8000-000000000001', repeat('a', 32)), 'a report is stored');
select ok(pg_temp.add('10000000-0000-4000-8000-000000000001', repeat('a', 32)), 'a retried upload is accepted');
select is((select count(*)::int from public.crash_reports where id = '10000000-0000-4000-8000-000000000001'), 1, '… and kept once');
select ok(pg_temp.add('10000000-0000-4000-8000-000000000002', repeat('a', 32), 'TypeError', '2.4.0'), 'same bug, another build');
select ok(pg_temp.add('10000000-0000-4000-8000-000000000003', repeat('b', 32), 'RangeError'), 'another bug');
select is((select received_at from public.crash_reports where id = '10000000-0000-4000-8000-000000000001'), date_trunc('hour', now()),
  'the time is kept to the hour');

-- The table refuses what the scrubber would never produce.
select throws_ok($$ select pg_temp.add('10000000-0000-4000-8000-000000000009', 'short') $$, '23514', null, 'a malformed fingerprint is refused');
select throws_ok($$ select public.crash_report_add('10000000-0000-4000-8000-000000000009', repeat('c', 32), 'error', 'android', '', '', '',
  'Android 14; Pixel 8', 'WebView 145', '/home', 'en', 'Error', '', 'at f', '') $$, '23514', null, 'a full device string is refused');
select throws_ok($$ select public.crash_report_add('10000000-0000-4000-8000-000000000009', repeat('c', 32), 'error', 'android', '', '', '',
  'Android 14', 'WebView 145', '/u/saito?x=1', 'en', 'Error', '', 'at f', '') $$, '23514', null, 'a route with a query string is refused');
select throws_ok($$ select public.crash_report_add('10000000-0000-4000-8000-000000000009', repeat('c', 32), 'error', 'android', '', '', '',
  'Android 14', 'WebView 145', '/home', 'en', 'Error', repeat('x', 301), 'at f', '') $$, '23514', null, 'an oversize message is refused');
select throws_ok($$ select public.crash_report_add('10000000-0000-4000-8000-000000000009', repeat('c', 32), 'error', 'android', '', '', '',
  'Android 14', 'WebView 145', '/home', 'en', 'Error', '', repeat('x', 4001), '') $$, '23514', null, 'an oversize stack is refused');

-- The daily cap: with three reports stored today, a cap of three refuses the next one.
select ok(not pg_temp.add('10000000-0000-4000-8000-000000000004', repeat('d', 32), 'Error', '2.5.0', 3), 'over the daily cap: not stored');
select is((select count(*)::int from public.crash_reports where id = '10000000-0000-4000-8000-000000000004'), 0, '… nothing written');

-- ---------------------------------------------------------------------------------------------
-- Reading: admins only
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('member');
select is((select count(*)::int from public.crash_reports), 0, 'a member sees no reports');
select throws_ok($$ select * from public.crash_report_groups() $$, '42501', null, 'a member cannot list groups');
select pg_temp.login('mod');
select is((select count(*)::int from public.crash_reports), 0, 'a moderator sees no reports');
select throws_ok($$ select * from public.crash_report_groups() $$, '42501', null, 'a moderator cannot list groups');
select pg_temp.anon();
select throws_ok($$ select * from public.crash_report_groups() $$, '42501', null, 'a visitor cannot list groups');

select pg_temp.login('admin');
select is((select count(*)::int from public.crash_reports), 3, 'an admin reads the reports');
select is((select count(*)::int from public.crash_report_groups()), 2, 'grouped by fingerprint');
select is((select reports::int from public.crash_report_groups() where fingerprint = repeat('a', 32)), 2, 'count per group');
select is((select versions from public.crash_report_groups() where fingerprint = repeat('a', 32)),
  array['2.4.0 58a235e0c1d2', '2.5.0 58a235e0c1d2'], 'the builds it happened in');
select is((select platforms from public.crash_report_groups() where fingerprint = repeat('a', 32)), array['android'], 'platforms');
select is((select sample ->> 'name' from public.crash_report_groups() where fingerprint = repeat('b', 32)), 'RangeError', 'a sample report');
select ok((select sample ? 'stack' and sample ? 'route' and not sample ? 'fingerprint' from public.crash_report_groups() limit 1), 'the sample is the stored report');
select throws_ok($$ delete from public.crash_reports $$, '42501', null, 'even an admin cannot delete by hand');
select throws_ok($$ update public.crash_reports set message = 'x' $$, '42501', null, '… or edit');

-- ---------------------------------------------------------------------------------------------
-- 30 days
-- ---------------------------------------------------------------------------------------------
select pg_temp.su();
update public.crash_reports set received_at = now() - interval '31 days' where id = '10000000-0000-4000-8000-000000000002';
update public.crash_reports set received_at = now() - interval '29 days' where id = '10000000-0000-4000-8000-000000000003';
select is(public.prune_crash_reports(), 1, 'prune deletes what is older than 30 days');
select is((select coalesce(array_agg(id::text order by 1), '{}') from public.crash_reports
            where id::text like '10000000-0000-4000-8000-%'),
  array['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'], 'newer reports stay');

select * from finish();
rollback;
