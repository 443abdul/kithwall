-- Message franking (20261102000600_message_franking.sql): the database tags each message's commitment with a
-- key nobody else can use, edits and unsends replace or drop it, and reports of messages are verified against
-- the commitment and the tag, including after the message has been unsent or has disappeared.
-- Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

-- Fixtures: Ann and Ben share a DM; Cal is in a group chat with Ann and Ben; Dee is a stranger; Mo moderates.
create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000f4a1'), ('ben', '00000000-0000-0000-0000-00000000f4b0'),
  ('cal', '00000000-0000-0000-0000-00000000f4c0'), ('dee', '00000000-0000-0000-0000-00000000f4d0'),
  ('mo', '00000000-0000-0000-0000-00000000f4e0');
grant select on ids to authenticated;

insert into auth.users (id, email, aud, role)
  select id, name || '-frank@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub)
  select id, name || 'frank', repeat('A', 43), repeat('B', 43) from ids;
insert into public.staff_roles (user_id, role) values ('00000000-0000-0000-0000-00000000f4e0', 'moderator');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.su() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;

-- What the apps compute (packages/crypto/src/franking.ts): the canonical body and its commitment.
create function pg_temp.body(conv text, msg text, sender text, txt text) returns text language sql as $$
  select format('{"conv":"%s","id":"%s","payload":{"text":"%s"},"sender":"%s","v":1}', conv, msg, txt, sender)
$$;
create function pg_temp.commit(fk text, body text) returns text language sql security definer as $$
  select kw.b64u(extensions.hmac(convert_to('kithwall/v1/frank' || chr(10) || body, 'UTF8'), kw.b64u32(fk), 'sha256'))
$$;
-- A report's franking evidence for message `msg`, as the reporter's device would send it.
create function pg_temp.evidence(msg text, fk text, body text) returns jsonb language sql security definer as $$
  select jsonb_build_object('plaintext', null, 'frank', jsonb_build_object(
    'fk', fk, 'body', body, 'commit', m.frank_commit, 'tag', m.frank_tag,
    'conv', m.conversation_id, 'sender', m.sender_id, 'at', coalesce(m.edited_at, m.created_at)))
  from public.messages m where m.id = msg::uuid
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- Two franking keys (the apps pick a fresh random one per message).
create temp table k (name text primary key, fk text);
insert into k values ('k1', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'), ('k2', 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8');
grant select on k to authenticated;

select pg_temp.su();
insert into public.audiences (id, owner_id, kind) values
  ('f4000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'conversation'),
  ('f4000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'conversation');
insert into public.audience_members (audience_id, member_id, role, status) values
  ('f4000000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 'admin', 'active'),
  ('f4000000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 'member', 'active'),
  ('f4000000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 'admin', 'active'),
  ('f4000000-0000-0000-0000-000000000002', pg_temp.uid('ben'), 'member', 'active'),
  ('f4000000-0000-0000-0000-000000000002', pg_temp.uid('cal'), 'member', 'active');
insert into public.conversations (id, audience_id, created_by, dm_key) values
  ('f4100000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', pg_temp.uid('ann'),
   least(pg_temp.uid('ann'), pg_temp.uid('ben'))::text || ':' || greatest(pg_temp.uid('ann'), pg_temp.uid('ben'))::text);
insert into public.conversations (id, audience_id, created_by) values
  ('f4100000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000002', pg_temp.uid('ann'));

-- ---------------------------------------------------------------------------------------------
-- 1. The key stays inside the database
-- ---------------------------------------------------------------------------------------------
select is((select count(*)::int from kw_secret.franking_keys), 1, 'the migration generated one franking key');
select is((select octet_length(key) from kw_secret.franking_keys limit 1), 32, 'of 32 random bytes');
select is((select value from public.app_settings where key = 'franking_required'), 'false'::jsonb, 'commitments are not required yet');
select is(pg_temp.commit('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  '{"conv":"00000000-0000-0000-0000-0000000000c1","id":"00000000-0000-0000-0000-0000000000d1","payload":{"text":"héllo"},"sender":"00000000-0000-0000-0000-0000000000e1","v":1}'),
  '6epbm1K22fQAKsx1t0sstUOxWdktI6ttxOrMbU4n1GQ', 'the database computes the same commitment as packages/crypto (shared vector)');

select pg_temp.login('ann');
select throws_ok($$ select key from kw_secret.franking_keys $$, '42501', null, 'users cannot read the franking key');
select throws_ok($$ select kw.frank_tag(gen_random_uuid(), gen_random_uuid(), auth.uid(), now(), '\x00'::bytea) $$,
  '42501', null, 'users cannot mint tags');
select throws_ok($$ select kw.frank_tag_ok('\x00'::bytea, gen_random_uuid(), gen_random_uuid(), auth.uid(), now(), '\x00'::bytea) $$,
  '42501', null, 'users cannot query the tag check directly');
select throws_ok($$ select kw.report_frank(gen_random_uuid(), '{}'::jsonb) $$, '42501', null, 'or the report check');

-- ---------------------------------------------------------------------------------------------
-- 2. Sending: the server tags the commitment
-- ---------------------------------------------------------------------------------------------
insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit, frank_tag)
  select 'f4200000-0000-0000-0000-000000000001', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 1, '{"v":1}',
         pg_temp.commit(k.fk, pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000001', pg_temp.uid('ann')::text, 'you will regret this')),
         'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    from k where name = 'k1';
select pg_temp.su();
select is((select frank_tag from public.messages where id = 'f4200000-0000-0000-0000-000000000001'),
  (select kw.frank_tag(m.conversation_id, m.id, m.sender_id, m.created_at, kw.b64u32(m.frank_commit)) from public.messages m
    where m.id = 'f4200000-0000-0000-0000-000000000001'),
  'the server tags the commitment with the sender, chat, id and its own clock (a client-supplied tag is replaced)');
select ok((select frank_tag <> 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' from public.messages where id = 'f4200000-0000-0000-0000-000000000001'),
  'the forged tag is gone');

select pg_temp.login('ann');
select lives_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('f4200000-0000-0000-0000-000000000002', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 1, '{"v":1}') $$,
  'older apps can still send without a commitment');
select is((select frank_tag from public.messages where id = 'f4200000-0000-0000-0000-000000000002'), null, 'such a message has no tag');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit)
  values ('f4200000-0000-0000-0000-000000000003', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 1, '{"v":1}', 'short') $$,
  '22023', null, 'a malformed commitment is refused');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit)
  values ('f4200000-0000-0000-0000-000000000003', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 1, '{"v":1}',
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB') $$,
  '22023', null, 'and so is a non-canonical one');

-- With commitments required, a message without one is refused.
select pg_temp.su();
update public.app_settings set value = 'true' where key = 'franking_required';
select pg_temp.login('ann');
select throws_ok($$ insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
  values ('f4200000-0000-0000-0000-000000000004', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ann'), 1, '{"v":1}') $$,
  '22023', null, 'once required, messages without a commitment are refused');
select pg_temp.su();
update public.app_settings set value = 'false' where key = 'franking_required';

-- ---------------------------------------------------------------------------------------------
-- 3. Reports
-- ---------------------------------------------------------------------------------------------
create temp table b (name text primary key, body text);
insert into b values ('m1', pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000001', pg_temp.uid('ann')::text, 'you will regret this'));
grant select on b to authenticated;

select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed, frank)
  select pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000001', 'harassment',
         pg_temp.evidence('f4200000-0000-0000-0000-000000000001', k.fk, b.body), '{"state":"verified"}'
    from k, b where k.name = 'k1' and b.name = 'm1';
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000001'), 'verified',
  'a report with the right franking key and body is verified');
select is((select frank ->> 'sender' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000001'), pg_temp.uid('ann')::text,
  'and names the sender the server bound');

-- The wrong key, a doctored body, or a body naming someone else: not verified.
select pg_temp.su(); delete from public.reports; select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000001', 'harassment',
         pg_temp.evidence('f4200000-0000-0000-0000-000000000001', k.fk, b.body)
    from k, b where k.name = 'k2' and b.name = 'm1';
select is((select frank ->> 'why' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000001'), 'commitment',
  'the wrong franking key fails');
select pg_temp.su(); delete from public.reports; select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000001', 'harassment',
         pg_temp.evidence('f4200000-0000-0000-0000-000000000001', k.fk, replace(b.body, 'regret', 'enjoy'))
    from k, b where k.name = 'k1' and b.name = 'm1';
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000001'), 'failed',
  'a doctored message fails');
select pg_temp.su(); delete from public.reports; select pg_temp.login('ben');
-- A body that commits correctly but is about another sender: Ben signs his own words "as Ann".
insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit)
  select 'f4200000-0000-0000-0000-000000000005', 'f4100000-0000-0000-0000-000000000001', pg_temp.uid('ben'), 1, '{"v":1}',
         pg_temp.commit(k.fk, pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000005', pg_temp.uid('ann')::text, 'framed'))
    from k where name = 'k1';
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000005', 'harassment',
         pg_temp.evidence('f4200000-0000-0000-0000-000000000005', k.fk,
           pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000005', pg_temp.uid('ann')::text, 'framed'))
    from k where name = 'k1';
select is((select frank ->> 'why' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000005'), 'body',
  'a body naming a different sender than the server bound fails');
select is((select target_owner_id from public.reports where target_id = 'f4200000-0000-0000-0000-000000000005'), pg_temp.uid('ben'),
  'and the report is about the real sender');

-- Included without evidence (older app / older message), or not included at all.
select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  values (pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000002', 'spam', '{"plaintext":{"text":"x"}}');
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000002' and disclosed is not null), 'none',
  'a message included without franking evidence couldn''t be verified');
insert into public.reports (reporter_id, target_kind, target_id, reason)
  values (pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000002', 'spam');
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000002' and disclosed is null), 'not_included',
  'a report without the message says so');

-- Moderators can't rewrite the verdict.
select pg_temp.login('mo');
select throws_ok($$ update public.reports set frank = '{"state":"verified"}' where target_id = 'f4200000-0000-0000-0000-000000000002' $$,
  'P0001', null, 'the franking verdict is immutable');

-- ---------------------------------------------------------------------------------------------
-- 4. Edits, unsend and disappearing messages
-- ---------------------------------------------------------------------------------------------
select pg_temp.su(); delete from public.reports;
-- Keep the original evidence, as the reporter's device would have it.
create temp table old_ev as select pg_temp.evidence('f4200000-0000-0000-0000-000000000001', k.fk, b.body) as ev
  from k, b where k.name = 'k1' and b.name = 'm1';
grant select on old_ev to authenticated;

select pg_temp.login('ann');
update public.messages set envelope = '{"v":1,"e":2}',
  frank_commit = pg_temp.commit((select fk from k where name = 'k2'),
    pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000001', pg_temp.uid('ann')::text, 'sorry'))
  where id = 'f4200000-0000-0000-0000-000000000001';
select pg_temp.su();
select is((select frank_tag from public.messages where id = 'f4200000-0000-0000-0000-000000000001'),
  (select kw.frank_tag(m.conversation_id, m.id, m.sender_id, m.edited_at, kw.b64u32(m.frank_commit)) from public.messages m
    where m.id = 'f4200000-0000-0000-0000-000000000001'),
  'an edit with a new commitment is tagged again, bound to the edit time');
select pg_temp.login('ann');
update public.messages set envelope = '{"v":1,"e":3}' where id = 'f4200000-0000-0000-0000-000000000001';
select is((select frank_commit from public.messages where id = 'f4200000-0000-0000-0000-000000000001'), null,
  'an edit without a new commitment drops the old one (it would bind the old text)');

-- The original text can still be reported with the evidence from before the edit (the tag binds it).
select pg_temp.login('ben');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('ben'), 'message', 'f4200000-0000-0000-0000-000000000001', 'harassment', ev from old_ev;
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000001'), 'verified',
  'the version before an edit stays reportable with its tag');

-- Unsend wipes the commitment with the ciphertext; the reporter's saved evidence still verifies.
select pg_temp.su(); delete from public.reports;
select pg_temp.login('ann');
insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit)
  select 'f4200000-0000-0000-0000-000000000006', 'f4100000-0000-0000-0000-000000000002', pg_temp.uid('ann'), 1, '{"v":1}',
         pg_temp.commit(k.fk, pg_temp.body('f4100000-0000-0000-0000-000000000002', 'f4200000-0000-0000-0000-000000000006', pg_temp.uid('ann')::text, 'group threat'))
    from k where name = 'k1';
select pg_temp.su();
create temp table group_ev as select pg_temp.evidence('f4200000-0000-0000-0000-000000000006', k.fk,
  pg_temp.body('f4100000-0000-0000-0000-000000000002', 'f4200000-0000-0000-0000-000000000006', pg_temp.uid('ann')::text, 'group threat')) as ev
  from k where k.name = 'k1';
grant select on group_ev to authenticated;
select pg_temp.login('ann');
select public.unsend_message('f4200000-0000-0000-0000-000000000006');
select is((select frank_commit from public.messages where id = 'f4200000-0000-0000-0000-000000000006'), null, 'unsend wipes the commitment');
select pg_temp.login('cal');
insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('cal'), 'message', 'f4200000-0000-0000-0000-000000000006', 'violence', ev from group_ev;
select is((select frank ->> 'state' from public.reports where target_id = 'f4200000-0000-0000-0000-000000000006'), 'verified',
  'a group member can still report an unsent message with verified evidence');

-- Gone entirely (disappeared and deleted by the clock), and the reporter has since been removed from the chat.
select pg_temp.su(); delete from public.reports;
delete from public.messages where id = 'f4200000-0000-0000-0000-000000000006';
delete from public.audience_members where audience_id = 'f4000000-0000-0000-0000-000000000002' and member_id = pg_temp.uid('cal');
select pg_temp.login('cal');
select lives_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('cal'), 'message', 'f4200000-0000-0000-0000-000000000006', 'violence', ev from group_ev $$,
  'verified evidence can be reported after the message is gone and the reporter was removed');
select is((select target_owner_id from public.reports where target_id = 'f4200000-0000-0000-0000-000000000006'), pg_temp.uid('ann'),
  'the report is about the sender the tag binds');

-- A stranger with made-up evidence for a message that no longer exists gets nowhere.
select pg_temp.login('dee');
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('dee'), 'message', 'f4200000-0000-0000-0000-000000000006', 'violence',
         jsonb_set(ev, '{frank,tag}', '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"') from group_ev $$,
  '42501', null, 'forged evidence for a vanished message is refused');
select throws_ok($$ insert into public.reports (reporter_id, target_kind, target_id, reason, disclosed)
  select pg_temp.uid('dee'), 'message', 'f4200000-0000-0000-0000-000000000006', 'violence',
         jsonb_set(ev, '{frank,sender}', to_jsonb(pg_temp.uid('ben'))) from group_ev $$,
  '42501', null, 'and real evidence re-attributed to someone else does not verify');

-- ---------------------------------------------------------------------------------------------
-- 5. Safety check-in alerts carry their commitment and are tagged on release
-- ---------------------------------------------------------------------------------------------
select pg_temp.login('ann');
select public.create_safety_checkin(now() + interval '1 hour', false, jsonb_build_array(jsonb_build_object(
  'id', 'f4200000-0000-0000-0000-000000000007', 'conversation_id', 'f4100000-0000-0000-0000-000000000001', 'epoch', 1,
  'envelope', jsonb_build_object('c', 'sealed'),
  'frank_commit', pg_temp.commit((select fk from k where name = 'k1'),
    pg_temp.body('f4100000-0000-0000-0000-000000000001', 'f4200000-0000-0000-0000-000000000007', pg_temp.uid('ann')::text, 'I did not check in')))));
select pg_temp.su();
update public.safety_checkins set due_at = now() - interval '1 minute' where owner_id = pg_temp.uid('ann');
select is(kw.release_checkin((select id from public.safety_checkins where owner_id = pg_temp.uid('ann'))), 1, 'the alert is released');
select is((select frank_tag from public.messages where id = 'f4200000-0000-0000-0000-000000000007'),
  (select kw.frank_tag(m.conversation_id, m.id, m.sender_id, m.created_at, kw.b64u32(m.frank_commit)) from public.messages m
    where m.id = 'f4200000-0000-0000-0000-000000000007'),
  'a released alert keeps its commitment and is tagged at release time');

select * from finish();
rollback;
