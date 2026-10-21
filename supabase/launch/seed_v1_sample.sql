-- Kithwall launch rehearsal: realistic v1 (2010-style app) data, for a THROWAWAY database only.
--
-- Load it into a database that has the v1 migrations (20261017000001 … 20261020000100) and nothing
-- newer, then apply the v2 migrations and run verify_cutover.sql: supabase/launch/rehearse.sh does all of
-- it (docs/v2/07-launch.md §2). NEVER run this against staging or production: it inserts auth users.
--
-- Shapes follow what the v1 app wrote (main branch, tag v1-classic): email + password accounts whose
-- key bundle has amkByPassword, end-to-end encrypted envelopes (dummy ciphertext here: the database
-- never looks inside them), audiences with sealed epoch keys, Wall posts by friends, groups (open,
-- closed, secret), events (public and private), Pages, questions with poll votes, check-ins, life
-- events, Kithville rows, pokes, photo albums with tag approvals, one-to-one and group chats with read
-- markers in audience_members, every v1 notification type, push subscriptions, invites, recovery
-- shares, reports and a scheduled deletion. Plus the awkward accounts: unconfirmed email without
-- keys, confirmed email that never finished /welcome, TOTP MFA, suspended, banned.
--
-- Timestamps: the v1 guard triggers stamp created_at = now(); a final block back-dates rows (with
-- triggers off) so the data looks like a year of use.

begin;
set local search_path = public, extensions;

create temp table v1 (name text primary key, id uuid not null, email text not null) on commit drop;
insert into v1 values
  ('ann', 'c1a55000-0000-4000-8000-000000000a01', 'ann@classic.invalid'),   -- TOTP MFA, admin of things
  ('ben', 'c1a55000-0000-4000-8000-000000000b01', 'ben@classic.invalid'),
  ('cat', 'c1a55000-0000-4000-8000-000000000c01', 'cat@classic.invalid'),
  ('dan', 'c1a55000-0000-4000-8000-000000000d01', 'dan@classic.invalid'),   -- pending request to ann; cat blocked him
  ('eve', 'c1a55000-0000-4000-8000-000000000e01', 'eve@classic.invalid'),   -- staff admin
  ('fay', 'c1a55000-0000-4000-8000-000000000f01', 'fay@classic.invalid'),   -- email NOT confirmed, no keys, no profile
  ('gus', 'c1a55000-0000-4000-8000-000000001001', 'gus@classic.invalid'),   -- confirmed, never created keys
  ('hal', 'c1a55000-0000-4000-8000-000000001101', 'hal@classic.invalid'),   -- suspended
  ('ivy', 'c1a55000-0000-4000-8000-000000001201', 'ivy@classic.invalid'),   -- scheduled deletion
  ('jon', 'c1a55000-0000-4000-8000-000000001301', 'jon@classic.invalid');   -- banned

create function pg_temp.u(n text) returns uuid language sql stable as $$ select id from v1 where name = n $$;
create function pg_temp.aud(n text, k text) returns uuid language sql stable as $$
  select a.id from public.audiences a where a.owner_id = pg_temp.u(n) and a.kind = k order by a.created_at limit 1 $$;
-- 43-char base64url public keys and a dummy envelope (v1 envelope fields; ciphertext is random).
create function pg_temp.k43(seed text) returns text language sql immutable as $$
  select rpad(translate(encode(extensions.digest(seed, 'sha256'), 'base64'), '+/=', '-_'), 43, 'A') $$;
create function pg_temp.env(seed text) returns jsonb language sql volatile as $$
  select jsonb_build_object('v', 1, 'alg', 'xchacha20poly1305', 'aud', seed,
    'n', translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_'),
    'ct', translate(encode(extensions.gen_random_bytes(96), 'base64'), '+/=', '-_'),
    'sig', translate(encode(extensions.gen_random_bytes(64), 'base64'), '+/=', '-_')) $$;

-- ---------------------------------------------------------------------------------------------
-- Auth users (email + password; v1 sent the Argon2-derived authKey as the Supabase password)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at,
                        confirmation_sent_at, banned_until)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
       extensions.crypt('derived-auth-key-' || name, extensions.gen_salt('bf')),
       case when name = 'fay' then null else now() - interval '300 days' end,
       case when name = 'fay' then 'pending-confirmation-' || name else '' end, '', '', '',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('altcha', 'spent'),
       now() - interval '300 days', now() - interval '3 days', now() - interval '3 days',
       case when name = 'fay' then now() - interval '2 days' end,
       case when name = 'jon' then now() + interval '100 years' end
  from v1;

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
select id::text, id, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', name <> 'fay'),
       'email', now() - interval '300 days', now(), now()
  from v1;

-- Ann has TOTP two-step verification (v1 Settings → Security).
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('c1a55000-0000-4000-8000-0000000f0a01', pg_temp.u('ann'), 'Phone', 'totp', 'verified',
        now() - interval '200 days', now() - interval '200 days', 'JBSWY3DPEHPK3PXP');

-- Key bundles (v1 shape: amkByPassword present) and profiles for everyone who finished /welcome.
insert into public.key_bundles (user_id, bundle)
select id, jsonb_build_object(
         'v', 1,
         'kdf', jsonb_build_object('alg', 'argon2id', 'v', 1, 'm', 65536, 't', 3, 'p', 1),
         'signPub', pg_temp.k43('sign:' || name), 'kxPub', pg_temp.k43('kx:' || name),
         'amkByPassword', translate(encode(extensions.gen_random_bytes(73), 'base64'), '+/=', '-_'),
         'amkByRecovery', translate(encode(extensions.gen_random_bytes(73), 'base64'), '+/=', '-_'),
         'identityEnc', translate(encode(extensions.gen_random_bytes(137), 'base64'), '+/=', '-_'),
         'rkCommitment', translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'))
  from v1 where name not in ('fay', 'gus');

insert into public.profiles (id, username, discoverable, display_name_public, sign_pub, kx_pub)
select id, 'classic.' || name, name in ('ann', 'eve'),
       case name when 'ann' then 'Ann Classic' when 'eve' then 'Eve Admin' end,
       pg_temp.k43('sign:' || name), pg_temp.k43('kx:' || name)
  from v1 where name not in ('fay', 'gus');
-- (on_profile_created made a 'friends' and a 'self' audience for each.)

update public.profiles set status = 'suspended', suspended_until = now() + interval '10 days' where id = pg_temp.u('hal');
update public.profiles set status = 'banned' where id = pg_temp.u('jon');
insert into public.staff_roles (user_id, role) values (pg_temp.u('eve'), 'admin'), (pg_temp.u('ann'), 'moderator');

insert into public.key_changes (user_id, change, sig)
select id, jsonb_build_object('v', 1, 'signPub', pg_temp.k43('sign:' || name), 'reason', 'created'), pg_temp.k43('sig:' || name)
  from v1 where name in ('ann', 'ben', 'cat');

insert into public.vault (user_id, blob)
select id, translate(encode(extensions.gen_random_bytes(400), 'base64'), '+/=', '-_') from v1 where name in ('ann', 'ben', 'cat', 'dan');

insert into public.profile_info (user_id, audience_id, epoch, envelope)
select id, pg_temp.aud(name, 'friends'), 1, pg_temp.env('profile:' || name) from v1 where name in ('ann', 'ben', 'cat', 'dan', 'eve');

-- ---------------------------------------------------------------------------------------------
-- Social graph
-- ---------------------------------------------------------------------------------------------
insert into public.friendships (user_a, user_b, status, requested_by, note)
select least(pg_temp.u(a), pg_temp.u(b)), greatest(pg_temp.u(a), pg_temp.u(b)), 'pending', pg_temp.u(a),
       case when a = 'dan' then pg_temp.env('intro') end
  from (values ('ann', 'ben'), ('ann', 'cat'), ('ben', 'cat'), ('ann', 'eve'), ('ann', 'hal'), ('ann', 'ivy'),
               ('dan', 'ann'), ('ben', 'dan')) f(a, b);
update public.friendships set status = 'accepted'
 where not (requested_by = pg_temp.u('dan') and pg_temp.u('ann') in (user_a, user_b));   -- dan → ann stays pending

insert into public.blocks (blocker, blocked) values (pg_temp.u('cat'), pg_temp.u('dan'));

-- Friend keys sealed to each friend (friends audience, epoch 1).
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
select a.id, 1, case when f.user_a = a.owner_id then f.user_b else f.user_a end, a.owner_id, pg_temp.env('key')
  from public.audiences a
  join public.friendships f on f.status = 'accepted' and a.owner_id in (f.user_a, f.user_b)
 where a.kind = 'friends';

-- Friend lists (v1 "Close friends", "Family") with explicit members.
insert into public.audiences (id, owner_id, kind, name_enc) values
  ('c1a55000-0000-4000-8000-00000000a151', pg_temp.u('ann'), 'list', pg_temp.env('list name: Close friends')),
  ('c1a55000-0000-4000-8000-00000000a152', pg_temp.u('ann'), 'list', pg_temp.env('list name: Family'));
insert into public.audience_members (audience_id, member_id, role, status) values
  ('c1a55000-0000-4000-8000-00000000a151', pg_temp.u('ben'), 'member', 'active'),
  ('c1a55000-0000-4000-8000-00000000a151', pg_temp.u('cat'), 'member', 'active'),
  ('c1a55000-0000-4000-8000-00000000a152', pg_temp.u('eve'), 'member', 'active');
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
select m.audience_id, 1, m.member_id, pg_temp.u('ann'), pg_temp.env('list key')
  from public.audience_members m where m.audience_id in ('c1a55000-0000-4000-8000-00000000a151', 'c1a55000-0000-4000-8000-00000000a152');

-- ---------------------------------------------------------------------------------------------
-- Groups: open (public name, unencrypted), closed, secret (= v2 circle)
-- ---------------------------------------------------------------------------------------------
insert into public.audiences (id, owner_id, kind, name_enc) values
  ('c1a55000-0000-4000-8000-0000000a0001', pg_temp.u('ann'), 'group', null),
  ('c1a55000-0000-4000-8000-0000000a0002', pg_temp.u('ann'), 'group', pg_temp.env('group name')),
  ('c1a55000-0000-4000-8000-0000000a0003', pg_temp.u('ben'), 'group', pg_temp.env('group name'));
insert into public.groups (id, creator_id, audience_id, privacy, name_public, envelope) values
  ('c1a55000-0000-4000-8000-0000000b0001', pg_temp.u('ann'), 'c1a55000-0000-4000-8000-0000000a0001', 'open', 'Classic Gardeners', null),
  ('c1a55000-0000-4000-8000-0000000b0002', pg_temp.u('ann'), 'c1a55000-0000-4000-8000-0000000a0002', 'closed', null, pg_temp.env('group details')),
  ('c1a55000-0000-4000-8000-0000000b0003', pg_temp.u('ben'), 'c1a55000-0000-4000-8000-0000000a0003', 'secret', null, pg_temp.env('group details'));
insert into public.audience_members (audience_id, member_id, role, status, invited_by) values
  ('c1a55000-0000-4000-8000-0000000a0001', pg_temp.u('ann'), 'admin', 'active', null),
  ('c1a55000-0000-4000-8000-0000000a0001', pg_temp.u('ben'), 'member', 'active', pg_temp.u('ann')),
  ('c1a55000-0000-4000-8000-0000000a0001', pg_temp.u('dan'), 'member', 'requested', null),
  ('c1a55000-0000-4000-8000-0000000a0002', pg_temp.u('ann'), 'admin', 'active', null),
  ('c1a55000-0000-4000-8000-0000000a0002', pg_temp.u('cat'), 'member', 'active', pg_temp.u('ann')),
  ('c1a55000-0000-4000-8000-0000000a0002', pg_temp.u('eve'), 'member', 'invited', pg_temp.u('ann')),
  ('c1a55000-0000-4000-8000-0000000a0003', pg_temp.u('ben'), 'admin', 'active', null),
  ('c1a55000-0000-4000-8000-0000000a0003', pg_temp.u('ann'), 'member', 'active', pg_temp.u('ben')),
  ('c1a55000-0000-4000-8000-0000000a0003', pg_temp.u('cat'), 'admin', 'active', pg_temp.u('ben'));
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
select m.audience_id, 1, m.member_id, a.owner_id, pg_temp.env('group key')
  from public.audience_members m join public.audiences a on a.id = m.audience_id
 where a.kind = 'group' and m.status in ('active', 'invited') and m.member_id <> a.owner_id;

-- ---------------------------------------------------------------------------------------------
-- Events: public (plaintext public_body) and private
-- ---------------------------------------------------------------------------------------------
insert into public.audiences (id, owner_id, kind) values
  ('c1a55000-0000-4000-8000-0000000a0e01', pg_temp.u('ann'), 'event'),
  ('c1a55000-0000-4000-8000-0000000a0e02', pg_temp.u('cat'), 'event');
insert into public.events (id, host_id, audience_id, is_public, public_body, envelope) values
  ('c1a55000-0000-4000-8000-0000000e0001', pg_temp.u('ann'), 'c1a55000-0000-4000-8000-0000000a0e01', false, null, pg_temp.env('event details')),
  ('c1a55000-0000-4000-8000-0000000e0002', pg_temp.u('cat'), 'c1a55000-0000-4000-8000-0000000a0e02', true,
   '{"title":"Classic picnic","starts_at":"2026-06-01T12:00:00Z","place":"The park"}', null);
insert into public.audience_members (audience_id, member_id, role, status, rsvp, invited_by) values
  ('c1a55000-0000-4000-8000-0000000a0e01', pg_temp.u('ann'), 'admin', 'active', 'yes', null),
  ('c1a55000-0000-4000-8000-0000000a0e01', pg_temp.u('ben'), 'member', 'active', 'maybe', pg_temp.u('ann')),
  ('c1a55000-0000-4000-8000-0000000a0e01', pg_temp.u('cat'), 'member', 'invited', null, pg_temp.u('ann')),
  ('c1a55000-0000-4000-8000-0000000a0e02', pg_temp.u('cat'), 'admin', 'active', 'yes', null),
  ('c1a55000-0000-4000-8000-0000000a0e02', pg_temp.u('ann'), 'member', 'active', 'no', pg_temp.u('cat'));
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
select m.audience_id, 1, m.member_id, a.owner_id, pg_temp.env('event key')
  from public.audience_members m join public.audiences a on a.id = m.audience_id
 where a.kind = 'event' and m.member_id <> a.owner_id;

-- ---------------------------------------------------------------------------------------------
-- Pages (public, plaintext) and likes
-- ---------------------------------------------------------------------------------------------
update public.app_settings set value = 'true'::jsonb where key = 'public_audience_enabled';   -- v1 had it on for Pages
insert into public.pages (id, owner_id, name, category, about) values
  ('c1a55000-0000-4000-8000-0000000f0001', pg_temp.u('ann'), 'Ann''s Bakery', 'Local business', 'Fresh bread since 2010.'),
  ('c1a55000-0000-4000-8000-0000000f0002', pg_temp.u('ben'), 'Ben''s Band', 'Musician/band', null);
insert into public.page_likes (page_id, user_id) values
  ('c1a55000-0000-4000-8000-0000000f0001', pg_temp.u('ben')), ('c1a55000-0000-4000-8000-0000000f0001', pg_temp.u('cat')),
  ('c1a55000-0000-4000-8000-0000000f0002', pg_temp.u('ann'));

-- ---------------------------------------------------------------------------------------------
-- Posts of every v1 kind and place
-- ---------------------------------------------------------------------------------------------
insert into public.posts (id, author_id, wall_owner_id, group_id, event_id, page_id, kind, is_public, audience_id, epoch, shared_post_id, envelope)
values
  -- Ann's own Wall
  ('c1a55000-0000-4000-8000-000000100001', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'status', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('status')),
  ('c1a55000-0000-4000-8000-000000100002', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'photo', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('photo post')),
  ('c1a55000-0000-4000-8000-000000100003', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'link', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('link')),
  ('c1a55000-0000-4000-8000-000000100004', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'video', false, 'c1a55000-0000-4000-8000-00000000a151', 1, null, pg_temp.env('video to close friends list')),
  ('c1a55000-0000-4000-8000-000000100005', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'question', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('question + options')),
  ('c1a55000-0000-4000-8000-000000100006', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'checkin', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('checkin with ben tagged')),
  ('c1a55000-0000-4000-8000-000000100007', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'life_event', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('new job')),
  ('c1a55000-0000-4000-8000-000000100008', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'game', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('Kithville harvest')),
  ('c1a55000-0000-4000-8000-000000100009', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'note', false, pg_temp.aud('ann', 'self'), 1, null, pg_temp.env('only-me note')),
  ('c1a55000-0000-4000-8000-00000010000a', pg_temp.u('ann'), pg_temp.u('ann'), null, null, null, 'status', true, null, null, null, pg_temp.env('public status')),
  -- Friends writing on Ann's Wall (encrypted to Ann's friends audience)
  ('c1a55000-0000-4000-8000-000000100011', pg_temp.u('ben'), pg_temp.u('ann'), null, null, null, 'status', false, pg_temp.aud('ann', 'friends'), 1, null, pg_temp.env('happy birthday ann')),
  ('c1a55000-0000-4000-8000-000000100012', pg_temp.u('cat'), pg_temp.u('ann'), null, null, null, 'share', false, pg_temp.aud('ann', 'friends'), 1, 'c1a55000-0000-4000-8000-000000100003', pg_temp.env('shared link')),
  -- Ann on Ben's Wall
  ('c1a55000-0000-4000-8000-000000100013', pg_temp.u('ann'), pg_temp.u('ben'), null, null, null, 'status', false, pg_temp.aud('ben', 'friends'), 1, null, pg_temp.env('hi ben')),
  -- Ben's and Cat's own Walls
  ('c1a55000-0000-4000-8000-000000100014', pg_temp.u('ben'), pg_temp.u('ben'), null, null, null, 'status', false, pg_temp.aud('ben', 'friends'), 1, null, pg_temp.env('ben status')),
  ('c1a55000-0000-4000-8000-000000100015', pg_temp.u('cat'), pg_temp.u('cat'), null, null, null, 'status', false, pg_temp.aud('cat', 'friends'), 1, null, pg_temp.env('cat status')),
  ('c1a55000-0000-4000-8000-000000100016', pg_temp.u('dan'), pg_temp.u('dan'), null, null, null, 'status', false, pg_temp.aud('dan', 'friends'), 1, null, pg_temp.env('dan status')),
  -- Groups
  ('c1a55000-0000-4000-8000-000000100021', pg_temp.u('ben'), null, 'c1a55000-0000-4000-8000-0000000b0001', null, null, 'status', true, null, null, null, pg_temp.env('open group post (public)')),
  ('c1a55000-0000-4000-8000-000000100022', pg_temp.u('cat'), null, 'c1a55000-0000-4000-8000-0000000b0002', null, null, 'status', false, 'c1a55000-0000-4000-8000-0000000a0002', 1, null, pg_temp.env('closed group post')),
  ('c1a55000-0000-4000-8000-000000100023', pg_temp.u('ann'), null, 'c1a55000-0000-4000-8000-0000000b0003', null, null, 'note', false, 'c1a55000-0000-4000-8000-0000000a0003', 1, null, pg_temp.env('secret group doc')),
  -- Events
  ('c1a55000-0000-4000-8000-000000100031', pg_temp.u('ben'), null, null, 'c1a55000-0000-4000-8000-0000000e0001', null, 'status', false, 'c1a55000-0000-4000-8000-0000000a0e01', 1, null, pg_temp.env('event wall')),
  ('c1a55000-0000-4000-8000-000000100032', pg_temp.u('cat'), null, null, 'c1a55000-0000-4000-8000-0000000e0002', null, 'status', true, null, null, null, pg_temp.env('public event wall')),
  -- Pages (always public)
  ('c1a55000-0000-4000-8000-000000100041', pg_temp.u('ann'), null, null, null, 'c1a55000-0000-4000-8000-0000000f0001', 'status', true, null, null, null, pg_temp.env('page update')),
  ('c1a55000-0000-4000-8000-000000100042', pg_temp.u('ben'), null, null, null, 'c1a55000-0000-4000-8000-0000000f0002', 'link', true, null, null, null, pg_temp.env('band link'));

insert into public.poll_votes (post_id, voter_id, envelope) values
  ('c1a55000-0000-4000-8000-000000100005', pg_temp.u('ben'), pg_temp.env('vote')),
  ('c1a55000-0000-4000-8000-000000100005', pg_temp.u('cat'), pg_temp.env('vote'));

insert into public.comments (id, post_id, photo_id, author_id, envelope) values
  ('c1a55000-0000-4000-8000-000000200001', 'c1a55000-0000-4000-8000-000000100001', null, pg_temp.u('ben'), pg_temp.env('comment')),
  ('c1a55000-0000-4000-8000-000000200002', 'c1a55000-0000-4000-8000-000000100001', null, pg_temp.u('ann'), pg_temp.env('reply')),
  ('c1a55000-0000-4000-8000-000000200003', 'c1a55000-0000-4000-8000-000000100011', null, pg_temp.u('ann'), pg_temp.env('thanks ben')),
  ('c1a55000-0000-4000-8000-000000200004', 'c1a55000-0000-4000-8000-000000100022', null, pg_temp.u('ann'), pg_temp.env('group comment'));

insert into public.likes (target_kind, target_id, user_id) values
  ('post', 'c1a55000-0000-4000-8000-000000100001', pg_temp.u('ben')),
  ('post', 'c1a55000-0000-4000-8000-000000100001', pg_temp.u('cat')),
  ('post', 'c1a55000-0000-4000-8000-000000100041', pg_temp.u('cat')),
  ('comment', 'c1a55000-0000-4000-8000-000000200001', pg_temp.u('ann'));

-- ---------------------------------------------------------------------------------------------
-- Photos: albums, photos, tags, comments, media objects (storage paths)
-- ---------------------------------------------------------------------------------------------
insert into public.albums (id, owner_id, is_public, audience_id, epoch, envelope) values
  ('c1a55000-0000-4000-8000-000000300001', pg_temp.u('ann'), false, pg_temp.aud('ann', 'friends'), 1, pg_temp.env('Summer 2010')),
  ('c1a55000-0000-4000-8000-000000300002', pg_temp.u('ann'), false, 'c1a55000-0000-4000-8000-00000000a152', 1, pg_temp.env('Family')),
  ('c1a55000-0000-4000-8000-000000300003', pg_temp.u('ben'), false, pg_temp.aud('ben', 'self'), 1, pg_temp.env('Only me'));
insert into public.photos (id, album_id, owner_id, position, is_public, audience_id, epoch, envelope) values
  ('c1a55000-0000-4000-8000-000000310001', 'c1a55000-0000-4000-8000-000000300001', pg_temp.u('ann'), 0, false, pg_temp.aud('ann', 'friends'), 1, pg_temp.env('photo 1 + tags')),
  ('c1a55000-0000-4000-8000-000000310002', 'c1a55000-0000-4000-8000-000000300001', pg_temp.u('ann'), 1, false, pg_temp.aud('ann', 'friends'), 1, pg_temp.env('photo 2')),
  ('c1a55000-0000-4000-8000-000000310003', 'c1a55000-0000-4000-8000-000000300002', pg_temp.u('ann'), 0, false, 'c1a55000-0000-4000-8000-00000000a152', 1, pg_temp.env('family photo')),
  ('c1a55000-0000-4000-8000-000000310004', 'c1a55000-0000-4000-8000-000000300003', pg_temp.u('ben'), 0, false, pg_temp.aud('ben', 'self'), 1, pg_temp.env('private photo'));
insert into public.tag_notices (photo_id, tagged_id, tagger_id, status) values
  ('c1a55000-0000-4000-8000-000000310001', pg_temp.u('ben'), pg_temp.u('ann'), 'approved'),
  ('c1a55000-0000-4000-8000-000000310001', pg_temp.u('cat'), pg_temp.u('ann'), 'pending');
insert into public.comments (id, post_id, photo_id, author_id, envelope) values
  ('c1a55000-0000-4000-8000-000000200011', null, 'c1a55000-0000-4000-8000-000000310001', pg_temp.u('ben'), pg_temp.env('photo comment'));
insert into public.likes (target_kind, target_id, user_id) values ('photo', 'c1a55000-0000-4000-8000-000000310001', pg_temp.u('ben'));
insert into public.media_objects (path, owner_id, post_id, photo_id, message_id, profile_avatar, bytes) values
  (pg_temp.u('ann') || '/c1a55000-0000-4000-8000-000000400001', pg_temp.u('ann'), null, null, null, true, 48211),
  (pg_temp.u('ann') || '/c1a55000-0000-4000-8000-000000400002', pg_temp.u('ann'), null, 'c1a55000-0000-4000-8000-000000310001', null, false, 1532211),
  (pg_temp.u('ann') || '/c1a55000-0000-4000-8000-000000400002-thumb', pg_temp.u('ann'), null, 'c1a55000-0000-4000-8000-000000310001', null, false, 30211),
  (pg_temp.u('ann') || '/c1a55000-0000-4000-8000-000000400003', pg_temp.u('ann'), 'c1a55000-0000-4000-8000-000000100002', null, null, false, 902211),
  (pg_temp.u('ben') || '/c1a55000-0000-4000-8000-000000400004', pg_temp.u('ben'), null, 'c1a55000-0000-4000-8000-000000310004', null, false, 202211);

-- ---------------------------------------------------------------------------------------------
-- Messages: a one-to-one chat (ann–ben), a group chat (ann, ben, cat) with v1 read markers
-- ---------------------------------------------------------------------------------------------
insert into public.audiences (id, owner_id, kind, current_epoch) values
  ('c1a55000-0000-4000-8000-0000000ac001', pg_temp.u('ann'), 'conversation', 1),
  ('c1a55000-0000-4000-8000-0000000ac002', pg_temp.u('cat'), 'conversation', 1);
update public.audiences set current_epoch = 2 where id = 'c1a55000-0000-4000-8000-0000000ac002';   -- someone left once
insert into public.conversations (id, audience_id, created_by, dm_key, rekey_needed) values
  ('c1a55000-0000-4000-8000-0000000c0001', 'c1a55000-0000-4000-8000-0000000ac001', pg_temp.u('ann'),
   least(pg_temp.u('ann'), pg_temp.u('ben'))::text || ':' || greatest(pg_temp.u('ann'), pg_temp.u('ben'))::text, false),
  ('c1a55000-0000-4000-8000-0000000c0002', 'c1a55000-0000-4000-8000-0000000ac002', pg_temp.u('cat'), null, false);
insert into public.audience_members (audience_id, member_id, role, status, last_read_at) values
  ('c1a55000-0000-4000-8000-0000000ac001', pg_temp.u('ann'), 'admin', 'active', now() - interval '1 day'),
  ('c1a55000-0000-4000-8000-0000000ac001', pg_temp.u('ben'), 'member', 'active', now() - interval '2 days'),
  ('c1a55000-0000-4000-8000-0000000ac002', pg_temp.u('cat'), 'admin', 'active', now() - interval '1 hour'),
  ('c1a55000-0000-4000-8000-0000000ac002', pg_temp.u('ann'), 'member', 'active', null),
  ('c1a55000-0000-4000-8000-0000000ac002', pg_temp.u('ben'), 'member', 'active', now() + interval '5 minutes');   -- clock skew in v1 data
insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
select m.audience_id, e.epoch, m.member_id, a.owner_id, pg_temp.env('chat key')
  from public.audience_members m join public.audiences a on a.id = m.audience_id
  cross join lateral generate_series(1, a.current_epoch) e(epoch)
 where a.kind = 'conversation' and m.member_id <> a.owner_id;
insert into public.messages (id, conversation_id, sender_id, epoch, envelope) values
  ('c1a55000-0000-4000-8000-000000500001', 'c1a55000-0000-4000-8000-0000000c0001', pg_temp.u('ann'), 1, pg_temp.env('hey')),
  ('c1a55000-0000-4000-8000-000000500002', 'c1a55000-0000-4000-8000-0000000c0001', pg_temp.u('ben'), 1, pg_temp.env('hi!')),
  ('c1a55000-0000-4000-8000-000000500003', 'c1a55000-0000-4000-8000-0000000c0002', pg_temp.u('cat'), 1, pg_temp.env('group hello')),
  ('c1a55000-0000-4000-8000-000000500004', 'c1a55000-0000-4000-8000-0000000c0002', pg_temp.u('ann'), 2, pg_temp.env('epoch 2'));
insert into public.media_objects (path, owner_id, message_id, bytes) values
  (pg_temp.u('ann') || '/c1a55000-0000-4000-8000-000000400011', pg_temp.u('ann'), 'c1a55000-0000-4000-8000-000000500001', 120000);

-- ---------------------------------------------------------------------------------------------
-- Notifications (every v1 type), pokes, invites, Kithville
-- ---------------------------------------------------------------------------------------------
insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id, sealed)
select pg_temp.u(r), pg_temp.u(a), t, k, o::uuid, pg_temp.env('preview')
  from (values
    ('ann', 'dan', 'friend_request', 'profile', 'c1a55000-0000-4000-8000-000000000d01'),
    ('ben', 'ann', 'friend_accept', 'profile', 'c1a55000-0000-4000-8000-000000000a01'),
    ('ann', 'ben', 'wall_post', 'post', 'c1a55000-0000-4000-8000-000000100011'),
    ('ann', 'ben', 'comment', 'post', 'c1a55000-0000-4000-8000-000000100001'),
    ('ann', 'cat', 'like', 'post', 'c1a55000-0000-4000-8000-000000100001'),
    ('ben', 'ann', 'tag', 'photo', 'c1a55000-0000-4000-8000-000000310001'),
    ('ann', 'ben', 'poke', 'profile', 'c1a55000-0000-4000-8000-000000000b01'),
    ('eve', 'ann', 'group_invite', 'group', 'c1a55000-0000-4000-8000-0000000b0002'),
    ('ann', 'dan', 'group_request', 'group', 'c1a55000-0000-4000-8000-0000000b0001'),
    ('cat', 'ann', 'event_invite', 'event', 'c1a55000-0000-4000-8000-0000000e0001'),
    ('ben', 'ann', 'mention', 'comment', 'c1a55000-0000-4000-8000-000000200002'),
    ('ann', 'cat', 'share', 'post', 'c1a55000-0000-4000-8000-000000100012'),
    ('ann', 'ben', 'question_vote', 'post', 'c1a55000-0000-4000-8000-000000100005'),
    ('ben', 'ann', 'checkin_tag', 'post', 'c1a55000-0000-4000-8000-000000100006'),
    ('ben', 'ann', 'relationship', 'profile', 'c1a55000-0000-4000-8000-000000000a01'),
    ('ben', 'ann', 'game', null, null),
    ('ann', 'cat', 'key_waiting', 'conversation', 'c1a55000-0000-4000-8000-0000000c0002'),
    ('ann', 'eve', 'like', 'page', 'c1a55000-0000-4000-8000-0000000f0001')
  ) n(r, a, t, k, o);

insert into public.pokes (from_id, to_id) values
  (pg_temp.u('ben'), pg_temp.u('ann')), (pg_temp.u('ann'), pg_temp.u('cat')), (pg_temp.u('dan'), pg_temp.u('ann'));

insert into public.invites (code, inviter_id, max_uses, uses) values
  ('c1a55c0de0000000000000a1', pg_temp.u('ann'), 10, 2),
  ('c1a55c0de0000000000000b1', pg_temp.u('ben'), 1, 0);

insert into public.game_state (user_id, blob, version) values
  (pg_temp.u('ann'), translate(encode(extensions.gen_random_bytes(900), 'base64'), '+/=', '-_'), 42),
  (pg_temp.u('ben'), translate(encode(extensions.gen_random_bytes(300), 'base64'), '+/=', '-_'), 3);
insert into public.game_actions (id, from_id, to_id, kind, sealed, claimed_at) values
  ('c1a55000-0000-4000-8000-000000600001', pg_temp.u('ben'), pg_temp.u('ann'), 'gift', pg_temp.env('gift'), null),
  ('c1a55000-0000-4000-8000-000000600002', pg_temp.u('ann'), pg_temp.u('ben'), 'help', pg_temp.env('help'), now());

-- ---------------------------------------------------------------------------------------------
-- Recovery, moderation, account lifecycle, push
-- ---------------------------------------------------------------------------------------------
insert into public.recovery_shares (owner_id, trustee_id, setup_id, threshold, sealed)
select pg_temp.u('ann'), pg_temp.u(t), 'c1a55000-0000-4000-8000-0000007e0001', 2, pg_temp.env('share') from (values ('ben'), ('cat'), ('eve')) s(t);
insert into public.recovery_requests (id, owner_id, eph_pub, status) values
  ('c1a55000-0000-4000-8000-000000700001', pg_temp.u('ann'), pg_temp.k43('eph'), 'cancelled');
insert into public.recovery_responses (request_id, trustee_id, sealed) values
  ('c1a55000-0000-4000-8000-000000700001', pg_temp.u('ben'), pg_temp.env('response'));

-- The reports guard checks the reporter can see the target (as v1 did, from the reporter's session).
do $$ begin perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('ben'), 'role', 'authenticated')::text, true); end $$;
insert into public.reports (id, reporter_id, target_kind, target_id, target_owner_id, reason, details, disclosed, stored_envelope, status, moderator_id, decision_note, resolved_at)
values ('c1a55000-0000-4000-8000-000000800001', pg_temp.u('ben'), 'post', 'c1a55000-0000-4000-8000-000000100016', pg_temp.u('dan'),
        'harassment', 'v1 report', '{"plaintext":"…","key":"…"}', pg_temp.env('stored'), 'actioned', pg_temp.u('eve'), 'warned', now()),
       ('c1a55000-0000-4000-8000-000000800002', pg_temp.u('ben'), 'page', 'c1a55000-0000-4000-8000-0000000f0001', pg_temp.u('ann'),
        'spam', null, null, null, 'open', null, null, null);
-- Moderation actions are applied by a trigger that checks the moderator's own session (eve, admin).
do $$ begin perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u('eve'), 'role', 'authenticated')::text, true); end $$;
insert into public.moderation_actions (moderator_id, target_user_id, report_id, action, reason) values
  (pg_temp.u('eve'), pg_temp.u('dan'), 'c1a55000-0000-4000-8000-000000800001', 'warn', 'Be kind.'),
  (pg_temp.u('eve'), pg_temp.u('hal'), null, 'suspend', 'Spam.'),
  (pg_temp.u('eve'), pg_temp.u('jon'), null, 'ban', 'Abuse.');
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;

insert into public.account_deletion_requests (user_id, requested_at, execute_after)
values (pg_temp.u('ivy'), now() - interval '1 day', now() + interval '2 days');
insert into public.notice_emails (kind, ref_id, user_id) values
  ('deletion_scheduled', pg_temp.u('ivy'), pg_temp.u('ivy')),
  ('recovery_started', 'c1a55000-0000-4000-8000-000000700001', pg_temp.u('ann'));
insert into public.key_challenges (user_id, purpose, used_at) values (pg_temp.u('ann'), 'change_recovery', now());

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_success_at) values
  (pg_temp.u('ann'), 'https://fcm.googleapis.com/fcm/send/classic-ann-1',
   'BElDgZ1q4mXo5w0bEzJ2c3eO4t7fCq1rWb9Kc5rP0cYw8sXj3nT6hL2aV9mQ4uR7yZ1dF5gH8jK0lN3pS6vX9b2E', 'c2VjcmV0LWF1dGgtMTIzNA', 'Chrome on Windows', now()),
  (pg_temp.u('ben'), 'https://updates.push.services.mozilla.com/wpush/v2/classic-ben',
   'BElDgZ1q4mXo5w0bEzJ2c3eO4t7fCq1rWb9Kc5rP0cYw8sXj3nT6hL2aV9mQ4uR7yZ1dF5gH8jK0lN3pS6vX9b2F', 'c2VjcmV0LWF1dGgtNTY3OA', 'Firefox on Linux', null);
insert into public.push_preferences (user_id, pokes, invites) values (pg_temp.u('ann'), false, true);

-- Spam-limit counters, including orphans from long-deleted accounts (20261024000900 removes those).
insert into kw.rate_events (user_id, action, at) values
  (pg_temp.u('ann'), 'post', now() - interval '2 days'),
  (pg_temp.u('ben'), 'message', now() - interval '30 days'),
  ('c1a55000-0000-4000-8000-0000deadbeef', 'post', now() - interval '200 days');

insert into public.altcha_spent (signature) values ('c1a55-spent-signature-0001');

-- ---------------------------------------------------------------------------------------------
-- Back-date (triggers off for these updates only: the guards would refuse/overwrite created_at)
-- ---------------------------------------------------------------------------------------------
set local session_replication_role = replica;
update public.profiles set created_at = now() - interval '300 days' where id in (select id from v1);
update public.friendships set created_at = now() - interval '280 days', accepted_at = case when status = 'accepted' then now() - interval '279 days' end
 where user_a in (select id from v1) or user_b in (select id from v1);
update public.posts set created_at = now() - (interval '1 day' * (abs(hashtext(id::text)) % 250 + 5))
 where author_id in (select id from v1);
update public.comments set created_at = now() - interval '4 days' where author_id in (select id from v1);
update public.messages set created_at = now() - (interval '1 hour' * (abs(hashtext(id::text)) % 500 + 3)) where sender_id in (select id from v1);
update public.notifications set created_at = now() - interval '6 days' where recipient_id in (select id from v1);
update public.pokes set created_at = now() - interval '50 days' where from_id in (select id from v1);
update public.albums set created_at = now() - interval '200 days', updated_at = now() - interval '100 days' where owner_id in (select id from v1);
update public.photos set created_at = now() - interval '199 days' where owner_id in (select id from v1);
update public.groups set created_at = now() - interval '260 days' where creator_id in (select id from v1);
update public.events set created_at = now() - interval '120 days' where host_id in (select id from v1);
update public.pages set created_at = now() - interval '220 days' where owner_id in (select id from v1);
update public.game_state set updated_at = now() - interval '90 days' where user_id in (select id from v1);
reset session_replication_role;

commit;

-- Row counts before the v2 migrations, for verify_cutover.sql (kept outside public: the v2
-- migrations refuse to run while any public table lacks row level security).
create schema if not exists launch;
drop table if exists launch.pre_counts;
create table launch.pre_counts as
  select c.relname::text as t,
         (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(c.relname), false, true, '')))[1]::text::int as n
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';
grant usage on schema launch to postgres, authenticated;
grant select on all tables in schema launch to postgres, authenticated;
