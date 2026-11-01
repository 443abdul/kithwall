-- Legacy contact (20261102000200_legacy_contact.sql): only the owner manages their row, the contact sees just
-- "you were chosen" until release and the sealed note only afterwards, nobody else sees anything, only the daily
-- job releases (after two reminders and a week's notice), opening the app takes a release back, and a remembered
-- account refuses new connections and chats. Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann, Ben and Cal are connected to each other; Dee is a stranger.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000e9a1'), ('ben', '00000000-0000-0000-0000-00000000e9b0'),
  ('cal', '00000000-0000-0000-0000-00000000e9c0'), ('dee', '00000000-0000-0000-0000-00000000e9d0');
grant select on ids to authenticated, service_role;

insert into auth.users (id, email, aud, role)
  select id, name || '-legacy@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'legacy', repeat('A', 43), repeat('B', 43) from ids;

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
create function pg_temp.friends(a text, b text) returns void language sql as $$
  insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  values (least(pg_temp.uid(a), pg_temp.uid(b)), greatest(pg_temp.uid(a), pg_temp.uid(b)), 'accepted', pg_temp.uid(a), now()) $$;
create function pg_temp.notes(recipient text, kind text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where recipient_id = pg_temp.uid(recipient) and type = kind $$;
-- Move Ann's period so that it ends `days` from today.
create function pg_temp.ends_in(days int) returns void language sql security definer as $$
  update public.legacy_contacts set last_active_on = (current_date + days) - make_interval(months => inactive_months)
   where owner_id = pg_temp.uid('ann') $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.su();
select pg_temp.friends('ann', 'ben');
select pg_temp.friends('ann', 'cal');
select pg_temp.friends('ben', 'cal');

-- A sealed box shape (the server never looks inside).
create temp table box (j jsonb);
insert into box values ('{"v":2,"eph":"e","kem":"k","n":"n","ct":"c","sig":"s"}');
grant select on box to authenticated;
create function pg_temp.kx() returns text language sql as $$ select repeat('K', 43) $$;
grant execute on function pg_temp.kx() to authenticated;

-- =============================================================================================
-- Setting up
-- =============================================================================================
select pg_temp.login('ann');
select throws_ok($$ select public.set_legacy_contact(pg_temp.uid('dee'), 6, null, null, null) $$, '42501', null,
  'only a connection can be the legacy contact');
select throws_ok($$ select public.set_legacy_contact(pg_temp.uid('ann'), 6, null, null, null) $$, '42501', null,
  'not yourself');
select throws_ok($$ select public.set_legacy_contact(pg_temp.uid('ben'), 4, null, null, null) $$, '22023', null,
  'the period is 3, 6 or 12 months');
select throws_ok($$ select public.set_legacy_contact(pg_temp.uid('ben'), 6, (select j from box), null, pg_temp.kx()) $$, '22023', null,
  'the note comes with the owner''s own copy and the key it was sealed to');
select throws_ok($$ insert into public.legacy_contacts (owner_id, contact_id, inactive_months) values (pg_temp.uid('ann'), pg_temp.uid('ben'), 6) $$,
  '42501', null, 'no direct writes');
select lives_ok($$ select public.set_legacy_contact(pg_temp.uid('ben'), 6, (select j from box), (select j from box), pg_temp.kx()) $$,
  'Ann chooses Ben, with a sealed note');
select is((select inactive_months::int from public.legacy_contacts), 6, 'Ann reads her own row');
select is((select last_active_on from public.legacy_contacts), current_date, 'the period starts today');
select is(pg_temp.notes('ben', 'legacy_contact'), 1, 'Ben is told he was chosen');
select lives_ok($$ select public.set_legacy_contact(pg_temp.uid('ben'), 12, (select j from box), (select j from box), pg_temp.kx()) $$,
  'Ann changes the period');
select is(pg_temp.notes('ben', 'legacy_contact'), 1, '...without telling Ben again');
select throws_ok($$ update public.profiles set memorialised_at = now() where id = pg_temp.uid('ann') $$, '42501', null,
  'nobody sets the remembered state by hand');

-- =============================================================================================
-- Before release: Ben sees only that he was chosen; Cal and Dee see nothing
-- =============================================================================================
select pg_temp.login('ben');
select is((select count(*)::int from public.legacy_contacts), 0, 'the contact cannot read the table');
select is((select count(*)::int from public.legacy_for_me() where owner_id = pg_temp.uid('ann')), 1, 'Ben sees that Ann chose him');
select is((select has_note from public.legacy_for_me()), null, '...but not whether there is a note');
select is((select released_at from public.legacy_for_me()), null, '...and nothing is released');
select is(public.legacy_note(pg_temp.uid('ann')), null, 'the sealed note is not available before release');
select throws_ok($$ select public.remember_account(pg_temp.uid('ann'), true) $$, '42501', null,
  'the account cannot be remembered before release');
select throws_ok($$ select public.legacy_tick() $$, '42501', null, 'users cannot run the release job');

select pg_temp.login('cal');
select is((select count(*)::int from public.legacy_contacts), 0, 'Cal sees no row');
select is((select count(*)::int from public.legacy_for_me()), 0, 'Cal is nobody''s legacy contact');
select throws_ok($$ select public.decline_legacy_contact(pg_temp.uid('ann')) $$, 'P0002', null, 'Cal cannot decline for Ben');
select pg_temp.login('dee');
select is((select count(*)::int from public.legacy_contacts), 0, 'Dee sees no row');

-- =============================================================================================
-- The daily job: two reminders, a week's notice, then release
-- =============================================================================================
select pg_temp.service();
select is(jsonb_array_length(public.legacy_tick()), 0, 'nothing happens while Ann is active');
select pg_temp.ends_in(25);
select is((select x->>'kind' from jsonb_array_elements(public.legacy_tick()) x), 'reminder', 'about 30 days before: a reminder');
select is(pg_temp.notes('ann', 'legacy_reminder'), 1, '...as a notification to Ann (which sends the push)');
select is(jsonb_array_length(public.legacy_tick()), 0, 'the same reminder is not sent twice');
select pg_temp.ends_in(0);
select is((select (x->>'days')::int from jsonb_array_elements(public.legacy_tick()) x where x->>'kind' = 'reminder'), 7,
  'a late second reminder still gives a week''s notice');
select is(pg_temp.notes('ann', 'legacy_reminder'), 2, 'Ann has two reminders');
select is(jsonb_array_length(public.legacy_tick()), 0, 'no release until a week after the last reminder');
select pg_temp.su();
update public.legacy_contacts set reminded_on = current_date - 7 where owner_id = pg_temp.uid('ann');
select pg_temp.service();
select is((select x->>'kind' from jsonb_array_elements(public.legacy_tick()) x), 'released', 'then the note is released');
select is(pg_temp.notes('ben', 'legacy_released'), 1, 'Ben is told');
select is(jsonb_array_length(public.legacy_tick()), 0, 'released only once');

-- =============================================================================================
-- After release
-- =============================================================================================
select pg_temp.login('ben');
select is((public.legacy_note(pg_temp.uid('ann')))->'sealed', (select j from box), 'Ben can fetch the sealed note');
select is((select has_note from public.legacy_for_me()), true, '...and knows there is one');
select throws_ok($$ select public.decline_legacy_contact(pg_temp.uid('ann')) $$, 'P0002', null, 'stepping back is for before release');
select pg_temp.login('cal');
select is(public.legacy_note(pg_temp.uid('ann')), null, 'Cal still cannot fetch it');

select pg_temp.login('ben');
select isnt(public.remember_account(pg_temp.uid('ann'), true), null, 'Ben chooses to remember Ann''s account');
select pg_temp.login('cal');
select isnt((select memorialised_at from public.profiles where id = pg_temp.uid('ann')), null, 'connections see the remembered state');

-- New connections and new chats are refused; existing connections stay.
select pg_temp.login('dee');
select throws_ok($$ insert into public.friendships (user_a, user_b, requested_by)
  values (least(pg_temp.uid('ann'), pg_temp.uid('dee')), greatest(pg_temp.uid('ann'), pg_temp.uid('dee')), pg_temp.uid('dee')) $$,
  '42501', 'remembered_account', 'a remembered account takes no connection requests');
select pg_temp.login('cal');
insert into public.audiences (id, owner_id, kind) values ('e9000000-0000-0000-0000-0000000000c1', pg_temp.uid('cal'), 'conversation');
select throws_ok($$ select public.create_conversation('e9000000-0000-0000-0000-0000000000c1', array[pg_temp.uid('ann')], true) $$,
  '42501', 'remembered_account', 'nobody starts a new chat with a remembered account');
insert into public.audiences (id, owner_id, kind) values ('e9000000-0000-0000-0000-0000000000c2', pg_temp.uid('cal'), 'conversation');
select lives_ok($$ select public.create_conversation('e9000000-0000-0000-0000-0000000000c2', array[pg_temp.uid('ben')], true) $$,
  'chats with other people still work');
select pg_temp.su();
select is((select count(*)::int from public.friendships where pg_temp.uid('ann') in (user_a, user_b)), 2, 'existing connections stay');

-- =============================================================================================
-- Ann comes back
-- =============================================================================================
select pg_temp.login('ann');
select is(public.legacy_seen(), '{"legacy": true, "returned": true}'::jsonb, 'opening the app takes the release back');
select is((select released_at from public.legacy_contacts), null, 'no longer released');
select is((select reminders::int from public.legacy_contacts), 0, 'reminders start over');
select is((select memorialised_at from public.profiles where id = pg_temp.uid('ann')), null, 'no longer remembered');
select is(pg_temp.notes('ben', 'legacy_active'), 1, 'Ben is told quietly');
select is(public.legacy_seen(), '{"legacy": true, "returned": false}'::jsonb, 'later visits just keep things on hold');
select pg_temp.login('ben');
select is(public.legacy_note(pg_temp.uid('ann')), null, 'the note is sealed away again');
select throws_ok($$ select public.remember_account(pg_temp.uid('ann'), true) $$, '42501', null, 'and cannot be remembered');
select pg_temp.login('dee');
select is(public.legacy_seen(), '{"legacy": false, "returned": false}'::jsonb, 'people without a legacy contact store nothing');

-- =============================================================================================
-- Stepping back, removing, disconnecting
-- =============================================================================================
select pg_temp.login('ben');
select lives_ok($$ select public.decline_legacy_contact(pg_temp.uid('ann')) $$, 'Ben steps back');
select pg_temp.login('ann');
select is((select count(*)::int from public.legacy_contacts), 0, 'Ann''s legacy contact is cleared');
select is(pg_temp.notes('ann', 'legacy_declined'), 1, '...and she is told');

select public.set_legacy_contact(pg_temp.uid('ben'), 3, null, null, null);
select lives_ok($$ select public.remove_legacy_contact() $$, 'Ann removes her legacy contact');
select is((select count(*)::int from public.legacy_contacts), 0, 'gone');

select public.set_legacy_contact(pg_temp.uid('ben'), 3, null, null, null);
select pg_temp.login('ben');
delete from public.friendships where user_a = least(pg_temp.uid('ann'), pg_temp.uid('ben')) and user_b = greatest(pg_temp.uid('ann'), pg_temp.uid('ben'));
select pg_temp.login('ann');
select is((select count(*)::int from public.legacy_contacts), 0, 'ending the connection clears the legacy contact');
select is(pg_temp.notes('ann', 'legacy_cleared'), 1, '...and Ann is told when the other person ended it');

select public.set_legacy_contact(pg_temp.uid('cal'), 3, null, null, null);
select pg_temp.login('cal');
insert into public.blocks (blocker, blocked) values (pg_temp.uid('cal'), pg_temp.uid('ann'));
select pg_temp.login('ann');
select is((select count(*)::int from public.legacy_contacts), 0, 'a block clears it too');
select is(pg_temp.notes('ann', 'legacy_cleared'), 1, '...without revealing the block');

-- Account deletion cascades.
select pg_temp.su();
delete from public.blocks where blocker = pg_temp.uid('cal');
select pg_temp.friends('ann', 'ben');
select pg_temp.login('ann');
select public.set_legacy_contact(pg_temp.uid('ben'), 3, null, null, null);
select pg_temp.su();
delete from auth.users where id = pg_temp.uid('ann');
select is((select count(*)::int from public.legacy_contacts where owner_id = pg_temp.uid('ann')), 0, 'deleting the account deletes the row');

-- Rights
select ok(not has_function_privilege('anon', 'public.legacy_seen()', 'execute'), 'anon cannot ping');
select ok(not has_function_privilege('authenticated', 'public.legacy_tick()', 'execute'), 'only the service role releases');
select ok(has_function_privilege('service_role', 'public.legacy_tick()', 'execute'), 'the daily job can');

select * from finish();
rollback;
