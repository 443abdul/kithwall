-- Integration: apply the "require MFA when enrolled" restrictive policy to every user-data table,
-- including tables created by migrations that ran after 20261018000100_auth_safety.
-- kw.require_mfa() is idempotent. New migrations after this one must call it for their tables.
do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and c.relname not in ('app_settings', 'altcha_spent', 'notice_emails')
  loop
    perform kw.require_mfa(t.rel);
  end loop;
end $$;

-- Every public table must have RLS enabled. Fail the migration loudly if one slipped through.
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'tables without row level security: %', missing;
  end if;
end $$;

-- Photos posted on a FRIEND's wall must be readable by the same people as the wall post: the wall
-- owner's friends. Individual photos (not albums) of mine may therefore be encrypted to the friends
-- audience of someone I'm friends with (and haven't blocked). It only widens who can read MY content.
create function kw.can_write_photo(owner uuid, is_public boolean, aud uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.can_write_item(owner, is_public, aud)
      or (owner = auth.uid() and kw.is_active() and not is_public
          and exists (select 1 from public.audiences a where a.id = aud and a.kind = 'friends'
                      and kw.is_friend(auth.uid(), a.owner_id) and not kw.is_blocked(auth.uid(), a.owner_id)))
$$;
revoke execute on function kw.can_write_photo(uuid, boolean, uuid) from public, anon;
grant execute on function kw.can_write_photo(uuid, boolean, uuid) to authenticated, service_role;

drop policy "write own photos" on public.photos;
create policy "write own photos" on public.photos for insert to authenticated
  with check (kw.can_write_photo(owner_id, is_public, audience_id)
              and exists (select 1 from public.albums a where a.id = album_id and a.owner_id = auth.uid()));
drop policy "update own photos" on public.photos;
create policy "update own photos" on public.photos for update to authenticated
  using (owner_id = auth.uid()) with check (kw.can_write_photo(owner_id, is_public, audience_id));
