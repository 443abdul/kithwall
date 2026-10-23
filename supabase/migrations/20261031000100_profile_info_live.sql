-- Profile changes reach connections live (a new photo, name or bio shows up without a reload).
--
-- profile_info is not in the Realtime publication: an RLS-filtered postgres_changes subscription would
-- make Realtime evaluate the read policy for every signed-in subscriber on every profile change. Instead
-- a change is announced only to the people who may read that row (the members of the audience it is
-- sealed to, plus the owner's other devices), on their existing private "db:<uid>" topic
-- (20261028010100_authz_realtime.sql: only that user receives, no client sends). Like the other db:
-- notices the payload is just the table name: no user id, no content. Clients then compare cheap
-- (user_id, audience_id, epoch, updated_at) stamps of the profiles they hold and re-read only the rows that
-- changed (lib/people.ts syncInfos), which is also what they do when a tab comes back to the foreground.
--
-- updated_at is now set by the server, so those stamps don't depend on a device's clock.

create function kw.profile_info_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger profile_info_stamp before insert or update on public.profile_info
  for each row execute function kw.profile_info_stamp();

create function kw.profile_info_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  m uuid;
begin
  select owner_id, kind into a from public.audiences where id = new.audience_id;
  if not found then return null; end if;
  perform kw.db_notify(new.user_id, 'profile_info');
  if a.kind = 'self' then return null; end if;
  for m in
    select case when f.user_a = a.owner_id then f.user_b else f.user_a end
      from public.friendships f
     where a.kind = 'friends' and f.status = 'accepted' and (f.user_a = a.owner_id or f.user_b = a.owner_id)
    union
    select am.member_id from public.audience_members am
     where a.kind <> 'friends' and am.audience_id = new.audience_id and am.status = 'active'
  loop
    -- Exactly the people the read policy lets see this row (blocked people and non-members get nothing).
    if m <> new.user_id and not kw.is_blocked(m, new.user_id) and kw.is_member(new.audience_id, m) then
      perform kw.db_notify(m, 'profile_info');
    end if;
  end loop;
  return null;
end $$;
create trigger profile_info_changed after insert or update on public.profile_info
  for each row execute function kw.profile_info_changed();

revoke execute on function kw.profile_info_stamp(), kw.profile_info_changed() from public, anon, authenticated;
