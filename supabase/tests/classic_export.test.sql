-- Kithwall Classic data export helpers (20261027000100_classic_export.sql). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('alice', '00000000-0000-0000-0000-0000000c1a01'), ('bob', '00000000-0000-0000-0000-0000000c1a02'),
  ('carol', '00000000-0000-0000-0000-0000000c1a03');
grant select on ids to authenticated;
insert into auth.users (id, email, aud, role) select id, name || '@classic-fixture.invalid', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub) select id, 'clsfix.' || name, repeat('A', 43), repeat('B', 43) from ids;

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated', 'aal', aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- v1 fixtures (written while Public was on in v1; Kithwall 2 runs with it off).
insert into public.pages (id, owner_id, name, category, about) values
  ('00000000-0000-0000-0000-0000000c1af1', pg_temp.uid('alice'), 'Alice''s Bakery', 'Local Business', 'Bread.');
insert into public.page_likes (page_id, user_id) values ('00000000-0000-0000-0000-0000000c1af1', pg_temp.uid('bob'));
insert into public.posts (id, author_id, page_id, kind, is_public, envelope)
  values ('00000000-0000-0000-0000-0000000c1ab1', pg_temp.uid('alice'), '00000000-0000-0000-0000-0000000c1af1', 'status', true, '{"v":1}');
update public.app_settings set value = 'false'::jsonb where key = 'public_audience_enabled';

select ok(not has_function_privilege('anon', 'public.classic_liked_pages()', 'execute'), 'anon cannot list liked Pages');
select ok(not has_function_privilege('anon', 'public.classic_page_posts()', 'execute'), 'anon cannot list Page posts');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.classic_liked_pages()'::regprocedure),
  'classic_liked_pages is SECURITY DEFINER with a pinned search_path');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.classic_page_posts()'::regprocedure),
  'classic_page_posts is SECURITY DEFINER with a pinned search_path');

select pg_temp.login('bob');
select is((select count(*)::int from public.pages), 0, 'with Public off, Bob cannot read the Page row itself');
select is((select array_agg(name) from public.classic_liked_pages()), array['Alice''s Bakery'], 'but he can export the names of the Pages he liked');
select is((select count(*)::int from public.classic_page_posts()), 0, 'and gets no posts from Pages he does not own');

select pg_temp.login('carol');
select is((select count(*)::int from public.classic_liked_pages()), 0, 'someone who liked nothing gets nothing');

select pg_temp.login('alice');
select is((select array_agg(id) from public.classic_page_posts()), array['00000000-0000-0000-0000-0000000c1ab1'::uuid], 'Alice exports the posts on her Page');
select is((select count(*)::int from public.classic_liked_pages()), 0, 'and her own likes only');

-- Two-step verification is honoured like everywhere else.
select pg_temp.su();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values ('00000000-0000-0000-0000-0000000c1aff', pg_temp.uid('bob'), 'phone', 'totp', 'verified', now(), now());
select pg_temp.login('bob', 'aal1');
select is((select count(*)::int from public.classic_liked_pages()), 0, 'an MFA account at aal1 gets nothing');
select pg_temp.login('bob', 'aal2');
select is((select count(*)::int from public.classic_liked_pages()), 1, 'and everything after the TOTP step');

select * from finish();
rollback;
