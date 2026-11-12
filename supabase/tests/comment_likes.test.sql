-- Likes and reactions on comments (migration 20261113000200_comment_likes.sql). Run with: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select * from no_plan();

create temp table ids (name text primary key, id uuid);
insert into ids values
  ('ann', '00000000-0000-0000-0000-00000000c1a1'),   -- writes the post
  ('ben', '00000000-0000-0000-0000-00000000c1b1'),   -- Ann's connection, comments on it
  ('cat', '00000000-0000-0000-0000-00000000c1c1'),   -- Ann's connection, likes Ben's comment (not connected to Ben)
  ('dan', '00000000-0000-0000-0000-00000000c1d1');   -- a stranger
grant select on ids to authenticated, anon;

insert into auth.users (id, email, aud, role)
  select id, name || '-clikes@test.local', 'authenticated', 'authenticated' from ids;
insert into public.profiles (id, username, sign_pub, kx_pub, created_at)
  select id, name || 'clqx', repeat('A', 43), repeat('B', 43), now() - interval '3 days' from ids;
insert into public.friendships (user_a, user_b, status, requested_by, accepted_at)
  select least(a.id, b.id), greatest(a.id, b.id), 'accepted', a.id, now()
  from ids a, ids b where a.name = 'ann' and b.name in ('ben', 'cat');

create function pg_temp.uid(n text) returns uuid language sql security definer as $$ select id from ids where name = n $$;
create function pg_temp.aud(n text, k text) returns uuid language sql security definer as $$
  select a.id from public.audiences a join ids on ids.id = a.owner_id where ids.name = n and a.kind = k $$;
create function pg_temp.login(n text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

-- Ann posts to her connections; Ben comments.
select pg_temp.login('ann');
insert into public.posts (id, author_id, wall_owner_id, kind, is_public, audience_id, epoch, envelope)
  values ('00000000-0000-0000-0000-0000000c1001', pg_temp.uid('ann'), pg_temp.uid('ann'), 'status', false, pg_temp.aud('ann', 'friends'), 1, '{"sig":"x","ct":"x"}');
select pg_temp.login('ben');
insert into public.comments (id, post_id, author_id, envelope)
  values ('00000000-0000-0000-0000-0000000c2001', '00000000-0000-0000-0000-0000000c1001', pg_temp.uid('ben'), '{"sig":"x","n":"x","ct":"x"}');

-- Whoever can read the post can like a comment on it, plainly or with a sealed reaction.
select pg_temp.login('cat');
select lives_ok($$ insert into public.likes (target_kind, target_id, user_id, sealed)
  values ('comment', '00000000-0000-0000-0000-0000000c2001', pg_temp.uid('cat'), '{"sig":"x","n":"x","ct":"x"}') $$,
  'a reader of the post reacts to a comment');
select is((select count(*) from public.likes where target_kind = 'comment' and target_id = '00000000-0000-0000-0000-0000000c2001'), 1::bigint,
  'and sees the reaction');
select lives_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ben'), pg_temp.uid('cat'), 'comment_like', 'post', '00000000-0000-0000-0000-0000000c1001') $$,
  'the comment''s author is told, about the post the comment is on');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ann'), pg_temp.uid('cat'), 'comment_like', 'post', '00000000-0000-0000-0000-0000000c1001') $$,
  '42501', null, 'someone whose comment was not liked cannot be told so');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ben'), pg_temp.uid('cat'), 'comment_like', 'comment', '00000000-0000-0000-0000-0000000c2001') $$,
  '42501', null, 'the notice is about the post, nothing else');

select pg_temp.login('ann');
select throws_ok($$ insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
  values (pg_temp.uid('ben'), pg_temp.uid('ann'), 'comment_like', 'post', '00000000-0000-0000-0000-0000000c1001') $$,
  '42501', null, 'a like that was never made cannot be announced');

select pg_temp.login('ben');
select is((select count(*) from public.notifications where recipient_id = pg_temp.uid('ben') and type = 'comment_like'), 1::bigint,
  'the author finds the notice');
select is((select count(*) from public.likes where target_kind = 'comment' and target_id = '00000000-0000-0000-0000-0000000c2001'), 1::bigint,
  'and can count the reactions to his comment');

-- A stranger can neither see nor add reactions on a post they cannot read.
select pg_temp.login('dan');
select is((select count(*) from public.likes where target_kind = 'comment' and target_id = '00000000-0000-0000-0000-0000000c2001'), 0::bigint,
  'a stranger sees no reactions');
select throws_ok($$ insert into public.likes (target_kind, target_id, user_id)
  values ('comment', '00000000-0000-0000-0000-0000000c2001', pg_temp.uid('dan')) $$,
  '42501', null, 'and cannot react');

select * from finish();
rollback;
