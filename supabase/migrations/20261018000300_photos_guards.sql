-- Photos hardening (engineer C):
--  * photo / album identity is immutable (a photo can't be moved into someone else's album,
--    or re-owned, by an UPDATE; the update policy only checks the audience),
--  * albums.updated_at follows photo changes so "Recently Updated Albums" is ordered server-side,
--  * photo uploads are rate-limited,
--  * tag notices can only change status (not who/what they point at).

create function kw.photos_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('photo', 2000, interval '1 day');
    new.created_at := now();
    return new;
  end if;
  if new.id <> old.id or new.owner_id <> old.owner_id or new.album_id <> old.album_id
     or new.created_at <> old.created_at then
    raise exception 'photo identity is immutable';
  end if;
  return new;
end $$;
create trigger photos_guard before insert or update on public.photos
  for each row execute function kw.photos_guard();

create function kw.albums_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('album', 300, interval '1 day');
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  if new.id <> old.id or new.owner_id <> old.owner_id or new.created_at <> old.created_at then
    raise exception 'album identity is immutable';
  end if;
  return new;
end $$;
create trigger albums_guard before insert or update on public.albums
  for each row execute function kw.albums_guard();

-- Keep the album's updated_at in step with its photos (insert / edit / delete).
create function kw.photos_touch_album() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.albums set updated_at = now()
   where id = case when tg_op = 'DELETE' then old.album_id else new.album_id end;
  return null;
end $$;
create trigger photos_touch_album after insert or update or delete on public.photos
  for each row execute function kw.photos_touch_album();

create index if not exists albums_owner_updated on public.albums (owner_id, updated_at desc);
create index if not exists albums_updated on public.albums (updated_at desc);

create function kw.tag_notices_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.photo_id <> old.photo_id or new.tagged_id <> old.tagged_id or new.tagger_id <> old.tagger_id
     or new.created_at <> old.created_at then
    raise exception 'tag notice identity is immutable';
  end if;
  return new;
end $$;
create trigger tag_notices_guard before update on public.tag_notices
  for each row execute function kw.tag_notices_guard();
