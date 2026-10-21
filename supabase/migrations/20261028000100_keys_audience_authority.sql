-- Security review K1 (Critical): audience / conversation key injection.
--
-- Before this migration any active member of a conversation could insert audience_keys rows for any
-- member and ANY epoch, including epochs that did not exist yet. A member could pre-plant keys for
-- future epochs, get removed, and keep reading after the rotation (clients adopted the first key whose
-- signature verified against `sealed_by`).
--
-- Now:
--  1. Key authority. Only the audience owner may mint keys for friends / self / list audiences; for
--     groups, events and conversations the owner or an active admin (kw.is_key_authority).
--  2. Epoch records (public.audience_epochs). When an authority mints the key for an epoch it publishes
--     a commitment to that key, signed with its identity key (packages/crypto/src/epoch.ts). The client
--     only adopts a key that matches the record, so a relaying member or the server cannot substitute a
--     key of its own, and conflicting keys are detected and flagged instead of silently adopted.
--     advance_audience_epoch() moves to the next epoch and stores its record atomically (compare-and-
--     swap on the epoch, so two admins never mint two keys for one epoch).
--  3. audience_keys INSERT: never for an epoch above the audience's current epoch. Authorities may seal
--     any epoch up to the current one (history for new group members); other conversation members may
--     only relay the CURRENT epoch, and only once its signed record exists. Recipients must still be
--     entitled (active member, or invited), so a removed member can never be given a post-rotation key.
--  4. A recipient may discard a key addressed to them (the client does this when a key fails the
--     record check, so the authority's delivery can take its place). A sealer may re-sign its own
--     delivery (after a signed identity-key rotation) but never move it to another audience, epoch or
--     recipient.
--  5. Existing data: rows planted for epochs above the current epoch are deleted. Older epochs have no
--     record; the client then accepts only keys sealed by a key authority. The authority's device writes
--     the record for the current epoch the next time it is online (record_audience_epoch).

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------
create function kw.is_key_authority(aud uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select u is not null and coalesce((
    select case when a.kind in ('friends', 'self', 'list') then a.owner_id = u
                else a.owner_id = u
                  or exists (select 1 from public.audience_members m
                              where m.audience_id = a.id and m.member_id = u and m.role = 'admin' and m.status = 'active')
           end
      from public.audiences a where a.id = aud), false)
$$;

create function kw.audience_current_epoch(aud uuid) returns int
language sql stable security definer set search_path = '' as $$
  select a.current_epoch from public.audiences a where a.id = aud
$$;

-- ---------------------------------------------------------------------------------------
-- Epoch records
-- ---------------------------------------------------------------------------------------
create table public.audience_epochs (
  audience_id uuid not null references public.audiences (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  rotated_by uuid not null references public.profiles (id) on delete cascade,
  commit text not null check (commit ~ '^[A-Za-z0-9_-]{43}$'),
  sig text not null check (sig ~ '^[A-Za-z0-9_-]{86}$'),
  created_at timestamptz not null default now(),
  primary key (audience_id, epoch)
);
create index audience_epochs_rotated_by on public.audience_epochs (rotated_by);
alter table public.audience_epochs enable row level security;
select kw.require_mfa('public.audience_epochs');

-- Definer helpers (policies on audience_keys and audience_epochs refer to each other).
create function kw.holds_epoch_key(aud uuid, ep int, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audience_keys k where k.audience_id = aud and k.epoch = ep and k.recipient_id = u)
$$;
create function kw.epoch_recorded(aud uuid, ep int) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audience_epochs e where e.audience_id = aud and e.epoch = ep)
$$;

create policy "members and key holders read epoch records" on public.audience_epochs
  for select to authenticated using (kw.is_member(audience_id) or kw.holds_epoch_key(audience_id, epoch));
-- Re-signing after an identity-key rotation: only the signature may change (guard below).
create policy "rotator re-signs own record" on public.audience_epochs
  for update to authenticated using (rotated_by = (select auth.uid())) with check (rotated_by = (select auth.uid()));

create function kw.audience_epochs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.audience_id <> old.audience_id or new.epoch <> old.epoch or new.rotated_by <> old.rotated_by
     or new.commit <> old.commit or new.created_at <> old.created_at then
    raise exception 'an epoch record is immutable (only its signature can be renewed)' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger audience_epochs_guard before update on public.audience_epochs
  for each row execute function kw.audience_epochs_guard();

-- Record the key of the CURRENT epoch (a new audience's first epoch, or a legacy epoch that predates
-- records). Returns false when a record already exists (the client then checks it against its key).
create function public.record_audience_epoch(aud uuid, ep int, p_commit text, p_sig text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cur int;
begin
  if uid is null or not kw.is_active(uid) then raise exception 'not signed in' using errcode = '42501'; end if;
  select a.current_epoch into cur from public.audiences a where a.id = aud for update;
  if not found or not kw.is_key_authority(aud, uid) then
    raise exception 'only the owner or an admin can mint keys for this audience' using errcode = '42501';
  end if;
  if ep is distinct from cur then raise exception 'only the current epoch can be recorded' using errcode = '22023'; end if;
  insert into public.audience_epochs (audience_id, epoch, rotated_by, commit, sig)
    values (aud, ep, uid, p_commit, p_sig)
    on conflict (audience_id, epoch) do nothing;
  return found;
end $$;

-- Rotation: advance from `from_epoch` to the next epoch and store its signed record in one step.
-- Returns the new epoch, or null when the epoch had already moved on (someone else rotated first).
create function public.advance_audience_epoch(aud uuid, from_epoch int, p_commit text, p_sig text) returns int
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cur int;
begin
  if uid is null or not kw.is_active(uid) then raise exception 'not signed in' using errcode = '42501'; end if;
  select a.current_epoch into cur from public.audiences a where a.id = aud for update;
  if not found or not kw.is_key_authority(aud, uid) then
    raise exception 'only the owner or an admin can rotate this key' using errcode = '42501';
  end if;
  if cur <> from_epoch then return null; end if;
  update public.audiences set current_epoch = from_epoch + 1 where id = aud;
  insert into public.audience_epochs (audience_id, epoch, rotated_by, commit, sig)
    values (aud, from_epoch + 1, uid, p_commit, p_sig);
  return from_epoch + 1;
end $$;

-- ---------------------------------------------------------------------------------------
-- audience_keys: who may hand out which key
-- ---------------------------------------------------------------------------------------
drop policy "deliver keys to members" on public.audience_keys;
create policy "deliver keys to members" on public.audience_keys
  for insert to authenticated with check (
    sealed_by = (select auth.uid())
    and kw.is_member(audience_id)                                 -- the sealer holds the key
    and (kw.is_member(audience_id, recipient_id)                  -- the recipient is entitled
         or exists (select 1 from public.audience_members m       -- or invited (gets the key on accept)
                    where m.audience_id = audience_keys.audience_id
                      and m.member_id = audience_keys.recipient_id and m.status = 'invited'))
    and epoch <= kw.audience_current_epoch(audience_id)          -- never a future epoch
    and (kw.is_key_authority(audience_id)                         -- the owner / an admin: any epoch so far
         or (kw.audience_kind(audience_id) = 'conversation'       -- a member relays the current key, once
             and epoch = kw.audience_current_epoch(audience_id)   -- its authority has recorded it
             and kw.epoch_recorded(audience_id, epoch)))
  );

create policy "recipient discards a key addressed to them" on public.audience_keys
  for delete to authenticated using (recipient_id = (select auth.uid()));

create policy "sealer re-signs own delivery" on public.audience_keys
  for update to authenticated using (sealed_by = (select auth.uid()) and kw.is_member(audience_id))
  with check (sealed_by = (select auth.uid()));

create function kw.audience_keys_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.audience_id <> old.audience_id or new.epoch <> old.epoch or new.recipient_id <> old.recipient_id
     or new.sealed_by <> old.sealed_by then
    raise exception 'a key delivery cannot be moved' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  return new;
end $$;
create trigger audience_keys_guard before update on public.audience_keys
  for each row execute function kw.audience_keys_guard();

-- ---------------------------------------------------------------------------------------
-- Existing data: drop keys planted for epochs that do not exist yet.
-- ---------------------------------------------------------------------------------------
delete from public.audience_keys k
 using public.audiences a
 where a.id = k.audience_id and k.epoch > a.current_epoch;

-- ---------------------------------------------------------------------------------------
-- Data map (transparency): every new column is classified.
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.audience_epochs', 'social', 't.rotated_by = $1', 'created_at', null, 'Until the circle, event or chat is deleted',
   'A signed fingerprint of each new key, so members can check the key they were given is the one its owner made.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.audience_epochs', 'audience_id', 'id', null), ('public.audience_epochs', 'epoch', 'plaintext', null),
  ('public.audience_epochs', 'rotated_by', 'id', null), ('public.audience_epochs', 'commit', 'hashed', 'a hash of the key, not the key'),
  ('public.audience_epochs', 'sig', 'plaintext', 'signature by the key owner'), ('public.audience_epochs', 'created_at', 'time', null);

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.audience_epochs_guard(), kw.audience_keys_guard() from public, anon, authenticated;
revoke execute on function kw.is_key_authority(uuid, uuid), kw.audience_current_epoch(uuid),
  kw.holds_epoch_key(uuid, int, uuid), kw.epoch_recorded(uuid, int) from public, anon;
grant execute on function kw.is_key_authority(uuid, uuid), kw.audience_current_epoch(uuid),
  kw.holds_epoch_key(uuid, int, uuid), kw.epoch_recorded(uuid, int) to authenticated, service_role;
revoke execute on function public.record_audience_epoch(uuid, int, text, text), public.advance_audience_epoch(uuid, int, text, text) from public, anon;
grant execute on function public.record_audience_epoch(uuid, int, text, text), public.advance_audience_epoch(uuid, int, text, text) to authenticated, service_role;
revoke all on public.audience_epochs from anon;
