-- Security re-review (docs/v2/06-security-review.md §10.2): R-K-2, R-K-3, R-K-4 support and R-K-5.
-- (R-K-1, verifying keys and signatures against PINNED identity keys, is client code: lib/keys/pins.ts,
-- people.ts, keyring.ts, authority.ts.)
--
-- R-K-2 "ghost admin": the roster that clients use to decide who may mint keys was unsigned server data, so
-- the operator could insert a puppet as an active admin and have members adopt the puppet's key.
--   1. Signed admin grants. audience_members gains grant_by / grant_sig: promoting someone to admin carries
--      an Ed25519 signature by the promoting owner/admin over (audience, member, granter)
--      (packages/crypto epoch.ts signAdminGrant). The database checks that the granter is the caller and a
--      key authority; clients verify the chain back to the owner against their PINNED keys and ignore
--      admins without one. kw.is_key_authority() no longer counts unsigned admins either.
--   2. Member-visible, content-free server notices whenever someone joins a group chat, circle or event,
--      is made an admin, or a chat changes hands: a notice message in group chats (like timer notices),
--      and public.audience_roster_notices for circles and events. Clients also keep their own record of who
--      the authorities were (vault namespace "rosterpins") and warn prominently about new ones, which does
--      not depend on the server telling them.
-- R-K-3 a member could starve another member of the current key by relaying garbage first: deliveries by a
--      key authority now replace relays (trigger), relays no longer count as "delivered" for the authority
--      (kw.key_delivered), and only authorities may rewrite their deliveries.
-- R-K-4 demoting an admin stranded members: the demoter's device rotates (client); clients rotate too when
--      the current record's rotator is no longer an authority (circle housekeeping).
-- R-K-5 a session-only attacker could overwrite key_bundles: the bundle is now written only by
--      /api/account/bundle after a proof-of-key (purpose 'update_bundle'), or by the definer RPCs that
--      already create or rotate it.

-- ---------------------------------------------------------------------------------------
-- R-K-2 (1): signed admin grants
-- ---------------------------------------------------------------------------------------
alter table public.audience_members
  add column grant_by uuid,
  add column grant_sig text check (grant_sig is null or grant_sig ~ '^[A-Za-z0-9_-]{86}$');

create function kw.audience_members_grant_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    -- Rows inserted by clients never carry a grant (only the owner may insert an admin row: their own).
    if auth.uid() is not null and not kw.trusted_write() then new.grant_by := null; new.grant_sig := null; end if;
    return new;
  end if;
  if new.role <> 'admin' or new.member_id = kw.audience_owner(new.audience_id) then
    new.grant_by := null; new.grant_sig := null;        -- demoted (or the owner, who needs no grant)
    return new;
  end if;
  if auth.uid() is null or kw.trusted_write() then return new; end if;
  if old.role = 'admin' and new.grant_by is not distinct from old.grant_by and new.grant_sig is not distinct from old.grant_sig then
    return new;                                          -- some other column (read marker, RSVP)
  end if;
  -- A promotion, or a re-signed grant: signed by the caller, who must be a key authority here.
  if new.grant_by is distinct from auth.uid() or new.grant_sig is null or not kw.is_key_authority(new.audience_id, auth.uid()) then
    raise exception 'an admin promotion must be signed by the owner or an admin' using errcode = '42501';
  end if;
  return new;
end $$;
-- Named to run after audience_members_guard (triggers fire in name order).
create trigger audience_members_guard_grant before insert or update on public.audience_members
  for each row execute function kw.audience_members_grant_guard();

-- Admins without a grant (made by the server, or before grants existed) are not key authorities.
create or replace function kw.is_key_authority(aud uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select u is not null and coalesce((
    select case when a.kind in ('friends', 'self', 'list') then a.owner_id = u
                else a.owner_id = u
                  or exists (select 1 from public.audience_members m
                              where m.audience_id = a.id and m.member_id = u and m.role = 'admin' and m.status = 'active'
                                and m.grant_sig is not null)
           end
      from public.audiences a where a.id = aud), false)
$$;

-- The owner leaving a group chat hands it over: owner first, so the successor's admin row needs no grant.
create or replace function public.leave_conversation(conv uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  a record;
  succ uuid;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select x.id, x.owner_id, x.kind, c.dm_key into a
    from public.conversations c join public.audiences x on x.id = c.audience_id
   where c.id = conv
   for update of x;
  if not found or not kw.is_member(a.id, uid) then
    raise exception 'not a member of this conversation' using errcode = '42501';
  end if;
  if a.kind <> 'conversation' then
    raise exception 'circle chats are left by leaving the circle' using errcode = '22023';
  end if;
  if a.dm_key is not null then
    raise exception 'one-to-one conversations can be archived, not left' using errcode = '22023';
  end if;
  if a.owner_id = uid then
    select m.member_id into succ from public.audience_members m
     where m.audience_id = a.id and m.member_id <> uid and m.status = 'active'
     order by (m.role = 'admin' and m.grant_sig is not null) desc, (m.role = 'admin') desc, m.created_at, m.member_id
     limit 1;
    if succ is null then
      delete from public.audiences where id = a.id;
      return;
    end if;
    update public.audiences set owner_id = succ where id = a.id;
    update public.audience_members set role = 'admin' where audience_id = a.id and member_id = succ;
  end if;
  delete from public.audience_members where audience_id = a.id and member_id = uid;
end $$;

-- ---------------------------------------------------------------------------------------
-- R-K-2 (2): roster notices
-- ---------------------------------------------------------------------------------------
create table public.audience_roster_notices (
  id bigint generated always as identity primary key,
  audience_id uuid not null references public.audiences (id) on delete cascade,
  member_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('joined', 'admin', 'owner')),
  created_at timestamptz not null default now()
);
create index audience_roster_notices_aud on public.audience_roster_notices (audience_id, created_at desc);
create index audience_roster_notices_member on public.audience_roster_notices (member_id);
create index audience_roster_notices_actor on public.audience_roster_notices (actor_id);
alter table public.audience_roster_notices enable row level security;
select kw.require_mfa('public.audience_roster_notices');
create policy "members see roster notices" on public.audience_roster_notices
  for select to authenticated using (kw.is_member(audience_id));
revoke insert, update, delete, truncate, references, trigger on public.audience_roster_notices from public, anon, authenticated;

-- One server notice (chat message or roster row) for a roster change. Content-free: who and what kind.
create function kw.post_roster_notice(aud uuid, member uuid, actor uuid, what text) returns void
language plpgsql security definer set search_path = '' as $$
declare k text; conv record; prev text := coalesce(current_setting('kw.trusted_write', true), '');
begin
  select a.kind into k from public.audiences a where a.id = aud;
  if k = 'conversation' then
    select c.id, c.dm_key into conv from public.conversations c where c.audience_id = aud;
    -- No conversation yet (create_conversation adds members first) or a 1:1 chat: nothing to announce.
    if not found or conv.dm_key is not null then return; end if;
    perform set_config('kw.trusted_write', 'on', true);
    insert into public.messages (id, conversation_id, sender_id, epoch, envelope, notice)
    values (gen_random_uuid(), conv.id, coalesce(actor, member),
            (select a.current_epoch from public.audiences a where a.id = aud), '{}'::jsonb,
            jsonb_build_object('kind', 'roster', 'what', what, 'm', member));
    perform set_config('kw.trusted_write', prev, true);
  elsif k in ('group', 'event') then
    insert into public.audience_roster_notices (audience_id, member_id, actor_id, kind) values (aud, member, actor, what);
  end if;
end $$;

create function kw.roster_member_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare own uuid; k text;
begin
  select a.owner_id, a.kind into own, k from public.audiences a where a.id = new.audience_id;
  if k is null or k not in ('group', 'event', 'conversation') or new.member_id = own then return null; end if;
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform kw.post_roster_notice(new.audience_id, new.member_id, auth.uid(), 'joined');
  end if;
  if new.role = 'admin' and new.status = 'active'
     and (tg_op = 'INSERT' or old.role is distinct from 'admin' or old.status is distinct from 'active') then
    perform kw.post_roster_notice(new.audience_id, new.member_id, auth.uid(), 'admin');
  end if;
  return null;
end $$;
create trigger roster_member_notice after insert or update of role, status on public.audience_members
  for each row execute function kw.roster_member_notice();

create function kw.roster_owner_notice() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind in ('group', 'event', 'conversation') then
    perform kw.post_roster_notice(new.id, new.owner_id, auth.uid(), 'owner');
  end if;
  return null;
end $$;
create trigger roster_owner_notice after update of owner_id on public.audiences
  for each row when (new.owner_id is distinct from old.owner_id) execute function kw.roster_owner_notice();

-- ---------------------------------------------------------------------------------------
-- R-K-3: authority deliveries win over relays
-- ---------------------------------------------------------------------------------------
-- For a key authority, only deliveries by an authority count (so it re-delivers over a relay); for anyone
-- else any delivery counts (relays are never stacked).
create or replace function kw.key_delivered(aud uuid, ep int, recipient uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.is_member(aud) and exists (
    select 1 from public.audience_keys k where k.audience_id = aud and k.epoch = ep and k.recipient_id = recipient
       and (not kw.is_key_authority(aud) or kw.is_key_authority(aud, k.sealed_by)))
$$;

create function kw.audience_keys_authority_wins() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if kw.is_key_authority(new.audience_id, new.sealed_by) then
    delete from public.audience_keys k
     where k.audience_id = new.audience_id and k.epoch = new.epoch and k.recipient_id = new.recipient_id
       and k.sealed_by <> new.sealed_by and not kw.is_key_authority(k.audience_id, k.sealed_by);
  end if;
  return new;
end $$;
create trigger audience_keys_authority_wins before insert on public.audience_keys
  for each row execute function kw.audience_keys_authority_wins();

drop policy "sealer re-signs own delivery" on public.audience_keys;
create policy "authority re-signs own delivery" on public.audience_keys
  for update to authenticated using (sealed_by = (select auth.uid()) and kw.is_member(audience_id) and kw.is_key_authority(audience_id))
  with check (sealed_by = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- R-K-5: key bundles change only through a proof-of-key route
-- ---------------------------------------------------------------------------------------
drop policy "owner updates bundle" on public.key_bundles;
select kw.extend_check('public.key_challenges', 'key_challenges_purpose_check', array['update_bundle']);

-- ---------------------------------------------------------------------------------------
-- Data map (transparency)
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.audience_members', 'grant_by', 'id', 'who made this person an admin'),
  ('public.audience_members', 'grant_sig', 'plaintext', 'that admin''s signature on the promotion');
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.audience_roster_notices', 'social', 't.member_id = $1 or t.actor_id = $1', 'created_at', null,
   'Until the circle or event is deleted',
   'Notices that someone joined, became an admin or took over a circle or event, shown to its members.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.audience_roster_notices', 'id', 'id', null), ('public.audience_roster_notices', 'audience_id', 'id', null),
  ('public.audience_roster_notices', 'member_id', 'id', null), ('public.audience_roster_notices', 'actor_id', 'id', null),
  ('public.audience_roster_notices', 'kind', 'plaintext', 'joined, admin or owner'), ('public.audience_roster_notices', 'created_at', 'time', null);

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.audience_members_grant_guard(), kw.roster_member_notice(), kw.roster_owner_notice(),
  kw.audience_keys_authority_wins(), kw.post_roster_notice(uuid, uuid, uuid, text) from public, anon, authenticated;
