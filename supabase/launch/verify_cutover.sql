-- Kithwall launch rehearsal: checks to run AFTER the v2 migrations were applied on top of v1 data.
--
-- Target: a THROWAWAY database prepared by supabase/launch/rehearse.sh (v1 migrations →
-- seed_v1_sample.sql → v2 migrations). Everything runs in one transaction that is rolled back, so it
-- can be run repeatedly. Prints pgTAP "ok"/"not ok" lines; rehearse.sh fails on any "not ok".
--
-- Covers docs/v2/07-launch.md §2: nothing lost, constraints hold, v1 accounts can still unlock and use
-- Kithwall 2, v1 content is readable by exactly the right people through the v2 policies and RPCs,
-- the first runs of the v2 cron jobs don't delete v1 data, and the data map covers every column.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table v1 (name text primary key, id uuid not null);
insert into v1 values
  ('ann', 'c1a55000-0000-4000-8000-000000000a01'), ('ben', 'c1a55000-0000-4000-8000-000000000b01'),
  ('cat', 'c1a55000-0000-4000-8000-000000000c01'), ('dan', 'c1a55000-0000-4000-8000-000000000d01'),
  ('eve', 'c1a55000-0000-4000-8000-000000000e01'), ('fay', 'c1a55000-0000-4000-8000-000000000f01'),
  ('gus', 'c1a55000-0000-4000-8000-000000001001'), ('hal', 'c1a55000-0000-4000-8000-000000001101'),
  ('ivy', 'c1a55000-0000-4000-8000-000000001201'), ('jon', 'c1a55000-0000-4000-8000-000000001301');
grant select on v1 to authenticated;

create function pg_temp.u(n text) returns uuid language sql stable security definer as $$ select id from v1 where name = n $$;
create function pg_temp.login(n text, aal text default 'aal1') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.u(n), 'role', 'authenticated', 'aal', aal, 'session_id', gen_random_uuid())::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
grant execute on all functions in schema pg_temp to authenticated;

create function pg_temp.post_ids() returns setof uuid language sql stable as $$ select id from public.posts $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Nothing was lost; the schema is what v2 expects
-- ---------------------------------------------------------------------------------------------
select is((select coalesce(array_agg(p.t || ': ' || p.n || ' -> ' || coalesce(
             (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(p.t), false, true, '')))[1]::text, 'gone')
             order by p.t), '{}')
             from launch.pre_counts p
            where to_regclass('public.' || quote_ident(p.t)) is null
               or (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(p.t), false, true, '')))[1]::text::int <> p.n),
  '{}'::text[], 'every v1 table still exists with the same number of rows');

select is((select count(*)::int from public.key_bundles where user_id in (select id from v1)), 8, 'all 8 v1 key bundles are intact');
select is((select count(*)::int from public.key_bundles b where b.user_id in (select id from v1)
            and b.bundle ? 'amkByPassword' and b.bundle ->> 'v' = '1'), 8, 'v1 bundles keep amkByPassword (email + password sign-in)');
select lives_ok($$ select kw.check_key_bundle(b.bundle) from public.key_bundles b where b.user_id in (select id from v1) $$,
  'every v1 key bundle passes the v2 bundle validator');
select ok((select bool_and(kw.has_fallback_unlock(b.user_id)) from public.key_bundles b where b.user_id in (select id from v1)),
  'v1 accounts count as having a fallback unlock (their password), so adding/removing passkeys works');
select is((select count(*)::int from public.profiles p join public.key_bundles b on b.user_id = p.id
            where p.id in (select id from v1) and p.sign_pub = b.bundle ->> 'signPub' and p.kx_pub = b.bundle ->> 'kxPub'), 8,
  'profile public keys still match the bundles');
select is((select count(*)::int from public.account_security where user_id in (select id from v1)), 0,
  'v1 accounts have no account_security row yet (the app shows the recovery nudge; created on first use)');
select is((select count(*)::int from public.passkeys where user_id in (select id from v1)), 0, 'v1 accounts start without passkeys');

-- Phase-2 messages migration: read markers moved to the owner-only table.
select is((select count(*)::int from public.conversation_reads r where r.user_id in (select id from v1)), 4,
  'v1 read markers were carried into conversation_reads');
select ok((select r.last_read_at <= now() from public.conversation_reads r
            where r.conversation_id = 'c1a55000-0000-4000-8000-0000000c0002' and r.user_id = pg_temp.u('ben')),
  'a future-dated v1 marker (clock skew) was clamped to now');
select is((select count(*)::int from public.audience_members m join public.audiences a on a.id = m.audience_id
            where a.kind = 'conversation' and m.last_read_at is not null), 0,
  'co-members can no longer see read markers in audience_members');

-- Phase-3 ephemeral migration: existing data keeps its v1 behaviour.
select is((select count(*)::int from public.conversations where id::text like 'c1a55000%' and disappear_secs is not null), 0,
  'existing chats were NOT switched to disappearing messages');
select is((select count(*)::int from public.messages where id::text like 'c1a55000%' and expires_at is not null), 0,
  'existing messages have no expiry');
select is((select count(*)::int from public.posts where id::text like 'c1a55000%'
            and (expires_at is not null or publish_at is not null or disappear_secs is not null)), 0,
  'existing posts are neither scheduled nor disappearing');
select is((select column_default from information_schema.columns
            where table_schema = 'public' and table_name = 'conversations' and column_name = 'disappear_secs'), '2419200',
  'NEW chats default to 4 weeks');
select ok((select pg_get_constraintdef(oid) like '%post_published%' and pg_get_constraintdef(oid) like '%poke%'
             from pg_constraint where conname = 'notifications_type_check'),
  'notification types gained post_published and kept the v1 types (old rows stay valid)');
select is((select count(*)::int from public.media_objects where owner_id in (select id from v1) and story_id is not null), 0,
  'media rows: story_id added, v1 rows unaffected');
select ok(not exists (select 1 from kw.rate_events r where not exists (select 1 from auth.users u where u.id = r.user_id)),
  'orphan rate-limit counters were removed before the new foreign key');
select is((select count(*)::int from kw.rate_events where (user_id, action) in ((pg_temp.u('ann'), 'post'), (pg_temp.u('ben'), 'message'))), 2,
  'counters of live accounts were kept');

-- Every constraint is validated (NOT VALID constraints would hide bad v1 rows).
select is((select coalesce(array_agg(conrelid::regclass::text || '.' || conname order by 1), '{}') from pg_constraint
            where not convalidated and connamespace in ('public'::regnamespace, 'kw'::regnamespace)),
  '{}'::text[], 'no NOT VALID constraints left behind');

-- Jobs: the v2 cron jobs exist.
select is((select array_agg(jobname order by jobname) from cron.job where jobname like 'kithwall-%'),
  array['kithwall-auth-maintenance', 'kithwall-ephemeral', 'kithwall-passkey-maintenance', 'kithwall-safety-checkins',
        'kithwall-story-maintenance', 'kithwall-transparency-maintenance'], 'all six pg_cron jobs are scheduled');

-- ---------------------------------------------------------------------------------------------
-- 2. The first cron runs after cutover don't touch v1 data
-- ---------------------------------------------------------------------------------------------
create temp table before_tick as
  select (select count(*) from public.posts) p, (select count(*) from public.messages) m,
         (select count(*) from public.media_objects) mo, (select count(*) from public.notifications) n,
         (select count(*) from auth.users where id in (select id from v1)) u;
select lives_ok($$ select kw.ephemeral_tick(); select kw.story_maintenance(); select kw.release_due_checkins();
                   select kw.passkey_maintenance(); select kw.transparency_maintenance(); select kw.auth_maintenance() $$,
  'every maintenance job runs on v1 data');
select is((select row(p, m, mo, n, u)::text from before_tick),
          (select row((select count(*) from public.posts), (select count(*) from public.messages), (select count(*) from public.media_objects),
                      (select count(*) from public.notifications), (select count(*) from auth.users where id in (select id from v1)))::text),
  'no posts, messages, files, notifications or accounts were deleted by them (ivy''s deletion is not due yet)');
select is((select count(*)::int from kw.media_trash), 0, 'no v1 file was sent to the media trash');

-- ---------------------------------------------------------------------------------------------
-- 3. v1 accounts in Kithwall 2
-- ---------------------------------------------------------------------------------------------
-- Ann has TOTP: the bundle stays hidden until the aal2 step (unchanged v1 rule, v2 sign-in honours it).
select pg_temp.login('ann', 'aal1');
select is((select count(*)::int from public.key_bundles), 0, 'MFA account at aal1 cannot read its key bundle');
select is((select count(*)::int from public.posts), 0, 'MFA account at aal1 reads no posts');
select pg_temp.login('ann', 'aal2');
select is((select count(*)::int from public.key_bundles), 1, 'MFA account at aal2 reads its own key bundle');
select is((select count(*)::int from public.profiles where id = pg_temp.u('ann')), 1, 'Ann has a profile (no /setup)');

-- Posts Ann may see: all her own (incl. only-me note and public), friends' posts on her and their
-- Walls, groups she is in (open, closed, secret), events she joined, Pages (public on).
select set_eq($$ select id from public.posts $$, $$ values
  ('c1a55000-0000-4000-8000-000000100001'::uuid), ('c1a55000-0000-4000-8000-000000100002'), ('c1a55000-0000-4000-8000-000000100003'),
  ('c1a55000-0000-4000-8000-000000100004'), ('c1a55000-0000-4000-8000-000000100005'), ('c1a55000-0000-4000-8000-000000100006'),
  ('c1a55000-0000-4000-8000-000000100007'), ('c1a55000-0000-4000-8000-000000100008'), ('c1a55000-0000-4000-8000-000000100009'),
  ('c1a55000-0000-4000-8000-00000010000a'), ('c1a55000-0000-4000-8000-000000100011'), ('c1a55000-0000-4000-8000-000000100012'),
  ('c1a55000-0000-4000-8000-000000100013'), ('c1a55000-0000-4000-8000-000000100014'), ('c1a55000-0000-4000-8000-000000100015'),
  ('c1a55000-0000-4000-8000-000000100021'), ('c1a55000-0000-4000-8000-000000100022'), ('c1a55000-0000-4000-8000-000000100023'),
  ('c1a55000-0000-4000-8000-000000100031'), ('c1a55000-0000-4000-8000-000000100032'), ('c1a55000-0000-4000-8000-000000100041'),
  ('c1a55000-0000-4000-8000-000000100042') $$,
  'Ann reads exactly her Wall, friends'' posts, her groups, events and Pages (not Dan''s: request still pending)');
select ok((select count(*) from public.feed_posts('infinity', 50)) >= 15, 'v2 home feed RPC works for a v1 account');
select ok(exists (select 1 from public.feed_posts('infinity', 50) f where f.id = 'c1a55000-0000-4000-8000-000000100011'),
  'a friend''s post on Ann''s Wall shows in her v2 feed');
select is((select count(*)::int from public.comments where post_id = 'c1a55000-0000-4000-8000-000000100001'), 2, 'comments readable');
select is((select count(*)::int from public.likes where target_id = 'c1a55000-0000-4000-8000-000000100001'), 2, 'likes readable');
select is((select count(*)::int from public.albums), 2, 'Ann sees her albums (not Ben''s only-me album)');
select is((select count(*)::int from public.photos), 3, 'Ann sees her photos');
select is((select count(*)::int from public.groups), 3, 'Ann sees her three groups');
select is((select count(*)::int from public.events), 2, 'Ann sees both events');
select is((select count(*)::int from public.conversations), 2, 'Ann sees both chats');
select is((select count(*)::int from public.messages), 4, 'Ann reads the DM and both epochs of the group chat');
select is((select count(*)::int from public.conversation_previews(array['c1a55000-0000-4000-8000-0000000c0001', 'c1a55000-0000-4000-8000-0000000c0002']::uuid[])), 2,
  'v2 chat list previews work on v1 chats');
select is((select count(*)::int from public.audience_keys where recipient_id = pg_temp.u('ann')), 9, 'Ann still receives her sealed v1 keys');
select is((select count(*)::int from public.notifications), 10, 'Ann''s v1 notifications are readable (including old types)');
select is((select count(*)::int from public.media_objects), 5, 'Ann sees her files');
select ok(public.transparency_report() is not null, 'transparency report runs for a v1 account');
select is((select (t ->> 'rows')::int from jsonb_array_elements(public.transparency_report() -> 'tables') t where t ->> 'table' = 'public.pokes'), 3,
  'transparency report counts Ann''s legacy pokes');
-- Classic export (lib/export.ts "Kithwall Classic data"): the owner can still read every v1-only row.
select is((select count(*)::int from public.pokes), 3, 'export: pokes sent and received');
select is((select count(*)::int from public.game_state), 1, 'export: own Kithville state');
select is((select count(*)::int from public.game_actions), 2, 'export: Kithville gifts/help');
select is((select count(*)::int from public.pages where owner_id = pg_temp.u('ann')), 1, 'export: Pages Ann created');
select is((select count(*)::int from public.page_likes where user_id = pg_temp.u('ann')), 1, 'export: Pages Ann liked');
select is((select count(*)::int from public.poll_votes where post_id = 'c1a55000-0000-4000-8000-000000100005'), 2, 'export: votes on Ann''s question');
select is((select count(*)::int from public.tag_notices), 2, 'export: photo tag approvals');
select is((select count(*)::int from public.audiences where kind = 'list' and owner_id = pg_temp.u('ann')), 2, 'export: friend lists');
select is((select count(*)::int from public.audience_members m join public.audiences a on a.id = m.audience_id
            where a.kind = 'list' and a.owner_id = pg_temp.u('ann')), 3, 'export: friend list members');
select is((select count(*)::int from public.vault), 1, 'export: own vault');

-- New v2 writes from a v1 account.
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope)
  values ('c1a55000-0000-4000-8000-0000009a0001', pg_temp.u('ann'), pg_temp.u('ann'), 'status',
          (select id from public.audiences where owner_id = pg_temp.u('ann') and kind = 'friends'), 1, '{"v":1}') $$,
  'a v1 account posts in Kithwall 2');
select lives_ok($$ insert into public.posts (id, author_id, wall_owner_id, kind, audience_id, epoch, envelope, disappear_secs)
  values ('c1a55000-0000-4000-8000-0000009a0002', pg_temp.u('ann'), pg_temp.u('ann'), 'status',
          (select id from public.audiences where owner_id = pg_temp.u('ann') and kind = 'friends'), 1, '{"v":1}', 86400) $$,
  'and can use a disappearing post');
select lives_ok($$ select public.mark_recovery_saved(true) $$, 'the recovery nudge can be dismissed (account_security row created)');
select lives_ok($$ select public.set_conversation_timer('c1a55000-0000-4000-8000-0000000c0001', 604800) $$, 'a v1 chat can opt in to disappearing');

select pg_temp.login('ben');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('c1a55000-0000-4000-8000-0000009b0001', 'c1a55000-0000-4000-8000-0000000c0001', pg_temp.u('ben'), 1, '{"v":1}') $$,
  'Ben replies in the v1 DM');
select ok((select expires_at is not null from public.messages where id = 'c1a55000-0000-4000-8000-0000009b0001'), 'and the opted-in timer applies');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100009'), 0, 'Ben cannot read Ann''s only-me note');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100004'), 1, 'Ben (close friends list) reads the list post');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100022'), 0, 'Ben cannot read the closed group he is not in');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100011'), 1, 'Ben reads what he wrote on Ann''s Wall');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-0000009a0001'), 1, 'Ben reads Ann''s new v2 post');
select is((select count(*)::int from public.albums where id = 'c1a55000-0000-4000-8000-000000300002'), 0, 'Ben cannot see the Family-list album');
select is((select count(*)::int from public.conversation_reads), 2, 'Ben sees only his own read markers');
select is((select count(*)::int from public.pokes), 1, 'Ben sees only pokes he was part of');
select is((select count(*)::int from public.game_state), 1, 'Ben sees only his own Kithville state');

select pg_temp.login('cat');
select is((select count(*)::int from public.posts where author_id = pg_temp.u('dan')), 0, 'Cat (who blocked Dan) cannot read Dan''s posts');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100022'), 1, 'Cat reads her closed group post');
select is((select count(*)::int from public.tag_notices where tagged_id = pg_temp.u('cat') and status = 'pending'), 1,
  'Cat still sees her pending tag approval (exportable)');

select pg_temp.login('dan');
select is((select count(*)::int from public.posts where wall_owner_id = pg_temp.u('ann') and not is_public), 0,
  'Dan (pending request) reads nothing on Ann''s Wall');
select is((select count(*)::int from public.posts where id = 'c1a55000-0000-4000-8000-000000100013'), 1,
  'but Dan reads what Ann wrote on Ben''s Wall (he is Ben''s friend: the v1 Wall rule still holds)');
select is((select count(*)::int from public.messages), 0, 'Dan reads no messages');

select pg_temp.login('eve');
select is((select count(*)::int from public.posts where group_id = 'c1a55000-0000-4000-8000-0000000b0002'), 0,
  'Eve (invited, not accepted) cannot read the closed group yet');
select is((select count(*)::int from public.reports), 2, 'Eve (admin) sees the v1 reports queue');

select pg_temp.login('hal');
select ok(not kw.is_active(), 'Hal stays suspended');
select pg_temp.login('jon');
select ok(not kw.is_active(), 'Jon stays banned');

-- Fay (unconfirmed) and Gus (never created keys) have no bundle and no profile: the app sends them to /setup.
select pg_temp.login('gus');
select is((select count(*)::int from public.key_bundles), 0, 'Gus has no key bundle (→ /setup)');
select is((select count(*)::int from public.profiles where id = pg_temp.u('gus')), 0, 'Gus has no profile (→ /setup)');
select pg_temp.su();
select ok((select email_confirmed_at is null from auth.users where id = pg_temp.u('fay')), 'Fay is still waiting for the email code');

-- Account deletion still cascades a v1 account completely.
select lives_ok($$ delete from auth.users where id = pg_temp.u('dan') $$, 'a v1 account with v1 + v2 rows can be deleted');
select is((select count(*)::int from public.posts where author_id = pg_temp.u('dan')), 0, 'its posts are gone');
select is((select count(*)::int from public.pokes where pg_temp.u('dan') in (from_id, to_id)), 0, 'its pokes are gone');

-- ---------------------------------------------------------------------------------------------
-- 4. Data map (transparency) — the same assertions as supabase/tests/transparency.test.sql
-- ---------------------------------------------------------------------------------------------
select is((select coalesce(array_agg(t.table_schema || '.' || t.table_name order by 1), '{}') from information_schema.tables t
            where t.table_schema in ('public', 'kw') and t.table_type = 'BASE TABLE'
              and not exists (select 1 from kw.data_map_tables m where m.table_name = t.table_schema || '.' || t.table_name)),
  '{}'::text[], 'every table is in the data map');
select is((select coalesce(array_agg(c.table_schema || '.' || c.table_name || '.' || c.column_name order by 1), '{}') from information_schema.columns c
            join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
            where c.table_schema in ('public', 'kw')
              and not exists (select 1 from kw.data_map_columns d where d.table_name = c.table_schema || '.' || c.table_name and d.column_name = c.column_name)),
  '{}'::text[], 'every column is classified');

select * from finish();
rollback;
