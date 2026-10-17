-- Content: groups/events/pages (containers), posts, comments, likes, polls, photos, media objects.

-- Containers -------------------------------------------------------------------------
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  audience_id uuid not null unique references public.audiences (id) on delete cascade,
  privacy text not null default 'closed' check (privacy in ('open', 'closed', 'secret')),
  name_public text check (char_length(name_public) between 1 and 120),
  envelope jsonb check (envelope is null or octet_length(envelope::text) < 16384),
  created_at timestamptz not null default now(),
  check ((privacy = 'open') = (name_public is not null))
);
alter table public.groups enable row level security;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  audience_id uuid not null unique references public.audiences (id) on delete cascade,
  is_public boolean not null default false,
  public_body jsonb check (public_body is null or octet_length(public_body::text) < 16384),
  envelope jsonb check (envelope is null or octet_length(envelope::text) < 16384),
  created_at timestamptz not null default now(),
  check (is_public = (public_body is not null))
);
alter table public.events enable row level security;

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  category text not null check (char_length(category) between 1 and 60),
  about text check (char_length(about) <= 2000),
  created_at timestamptz not null default now()
);
alter table public.pages enable row level security;

create table public.page_likes (
  page_id uuid not null references public.pages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (page_id, user_id)
);
alter table public.page_likes enable row level security;

create function kw.audience_kind(aud uuid) returns text
language sql stable security definer set search_path = '' as $$
  select kind from public.audiences where id = aud
$$;

create policy "group visible to members/invitees; open groups when public enabled" on public.groups
  for select to authenticated using (
    kw.can_see_audience(audience_id) or (privacy = 'open' and kw.public_enabled())
  );
create policy "create group" on public.groups
  for insert to authenticated with check (
    creator_id = auth.uid() and kw.is_active()
    and kw.audience_owner(audience_id) = auth.uid() and kw.audience_kind(audience_id) = 'group'
    and (privacy <> 'open' or kw.public_enabled())
  );
create policy "admins update group" on public.groups
  for update to authenticated using (kw.is_audience_admin(audience_id)) with check (kw.is_audience_admin(audience_id));
create policy "creator deletes group" on public.groups
  for delete to authenticated using (creator_id = auth.uid() or kw.is_staff());

create policy "event visible to invitees; public events when enabled" on public.events
  for select to authenticated using (
    kw.can_see_audience(audience_id) or (is_public and kw.public_enabled())
  );
create policy "create event" on public.events
  for insert to authenticated with check (
    host_id = auth.uid() and kw.is_active()
    and kw.audience_owner(audience_id) = auth.uid() and kw.audience_kind(audience_id) = 'event'
    and (not is_public or kw.public_enabled())
  );
create policy "admins update event" on public.events
  for update to authenticated using (kw.is_audience_admin(audience_id)) with check (kw.is_audience_admin(audience_id));
create policy "host deletes event" on public.events
  for delete to authenticated using (host_id = auth.uid() or kw.is_staff());

create policy "pages readable when public enabled" on public.pages
  for select to authenticated using (kw.public_enabled() or owner_id = auth.uid());
create policy "create page when public enabled" on public.pages
  for insert to authenticated with check (owner_id = auth.uid() and kw.public_enabled() and kw.is_active());
create policy "owner updates page" on public.pages
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner or staff deletes page" on public.pages
  for delete to authenticated using (owner_id = auth.uid() or kw.is_staff());

-- Which pages you like is private: only you can see your rows. Counts via function.
create policy "own page likes" on public.page_likes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and kw.public_enabled());
create function public.page_like_count(page uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from public.page_likes where page_id = page
$$;

-- Posts --------------------------------------------------------------------------------
create table public.posts (
  id uuid primary key,                       -- client-generated (bound into the envelope header)
  author_id uuid not null references public.profiles (id) on delete cascade,
  wall_owner_id uuid references public.profiles (id) on delete cascade,
  group_id uuid references public.groups (id) on delete cascade,
  event_id uuid references public.events (id) on delete cascade,
  page_id uuid references public.pages (id) on delete cascade,
  kind text not null check (kind in ('status', 'photo', 'link', 'video', 'question', 'checkin',
                                     'note', 'share', 'life_event', 'game')),
  is_public boolean not null default false,
  audience_id uuid references public.audiences (id) on delete cascade,
  epoch int check (epoch >= 1),
  shared_post_id uuid references public.posts (id) on delete set null,
  envelope jsonb not null check (octet_length(envelope::text) < 65536),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  check (num_nonnulls(wall_owner_id, group_id, event_id, page_id) = 1),
  check ((is_public and audience_id is null and epoch is null)
      or (not is_public and audience_id is not null and epoch is not null)),
  check (page_id is null or is_public)
);
create index posts_wall on public.posts (wall_owner_id, created_at desc);
create index posts_author on public.posts (author_id, created_at desc);
create index posts_audience on public.posts (audience_id, created_at desc);
create index posts_group on public.posts (group_id, created_at desc) where group_id is not null;
create index posts_event on public.posts (event_id, created_at desc) where event_id is not null;
create index posts_page on public.posts (page_id, created_at desc) where page_id is not null;
create index posts_created on public.posts (created_at desc);
alter table public.posts enable row level security;

create function kw.can_read_post(p uuid, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  select author_id, wall_owner_id, is_public, audience_id into r from public.posts where id = p;
  if not found then return false; end if;
  if u in (r.author_id, r.wall_owner_id) then return true; end if;
  if kw.is_blocked(u, r.author_id) or (r.wall_owner_id is not null and kw.is_blocked(u, r.wall_owner_id)) then
    return false;
  end if;
  if r.is_public then return kw.public_enabled(); end if;
  return kw.is_member(r.audience_id, u);
end $$;

create policy "read posts in your audiences" on public.posts
  for select to authenticated using (kw.can_read_post(id));

create function kw.can_post(p public.posts) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare aud record;
begin
  if p.author_id <> auth.uid() or not kw.is_active() then return false; end if;
  if p.is_public then
    if not kw.public_enabled() then return false; end if;
  else
    select owner_id, kind into aud from public.audiences where id = p.audience_id;
    if not found or not kw.is_member(p.audience_id) then return false; end if;
  end if;

  if p.wall_owner_id is not null then
    if p.wall_owner_id = auth.uid() then
      -- own wall: own friends / list / self audience, or public
      return p.is_public or (aud.owner_id = auth.uid() and aud.kind in ('friends', 'list', 'self'));
    end if;
    -- friend's wall: must be friends, not blocked, audience = wall owner's friends audience
    return kw.is_friend(auth.uid(), p.wall_owner_id) and not kw.is_blocked(auth.uid(), p.wall_owner_id)
       and not p.is_public and aud.owner_id = p.wall_owner_id and aud.kind = 'friends';
  elsif p.group_id is not null then
    return exists (select 1 from public.groups g where g.id = p.group_id
                   and ((not p.is_public and g.audience_id = p.audience_id)
                     or (p.is_public and g.privacy = 'open')))
       and exists (select 1 from public.groups g where g.id = p.group_id and kw.is_member(g.audience_id));
  elsif p.event_id is not null then
    return exists (select 1 from public.events e where e.id = p.event_id and kw.is_member(e.audience_id)
                   and ((not p.is_public and e.audience_id = p.audience_id) or (p.is_public and e.is_public)));
  elsif p.page_id is not null then
    return p.is_public and exists (select 1 from public.pages g where g.id = p.page_id);
  end if;
  return false;
end $$;

create policy "write posts you are allowed to" on public.posts
  for insert to authenticated with check (kw.can_post(posts));
create policy "author edits post" on public.posts
  for update to authenticated using (author_id = auth.uid()) with check (kw.can_post(posts));
create policy "author, wall owner, group admin or staff deletes post" on public.posts
  for delete to authenticated using (
    author_id = auth.uid() or wall_owner_id = auth.uid() or kw.is_staff()
    or (group_id is not null and exists (select 1 from public.groups g
        where g.id = group_id and kw.is_audience_admin(g.audience_id)))
    or (page_id is not null and exists (select 1 from public.pages g where g.id = page_id and g.owner_id = auth.uid()))
  );

create function kw.posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('post', 300, interval '1 day');
    new.created_at := now();
    new.edited_at := null;
    return new;
  end if;
  if new.id <> old.id or new.author_id <> old.author_id or new.created_at <> old.created_at
     or new.wall_owner_id is distinct from old.wall_owner_id or new.group_id is distinct from old.group_id
     or new.event_id is distinct from old.event_id or new.page_id is distinct from old.page_id
     or new.kind <> old.kind then
    raise exception 'post identity is immutable';
  end if;
  new.edited_at := now();
  return new;
end $$;
create trigger posts_guard before insert or update on public.posts
  for each row execute function kw.posts_guard();

-- Photos (album items) ---------------------------------------------------------------
create table public.albums (
  id uuid primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  is_public boolean not null default false,
  audience_id uuid references public.audiences (id) on delete cascade,
  epoch int,
  envelope jsonb not null check (octet_length(envelope::text) < 16384),   -- name, description, location
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_public and audience_id is null and epoch is null) or (not is_public and audience_id is not null and epoch is not null))
);
alter table public.albums enable row level security;

create table public.photos (
  id uuid primary key,
  album_id uuid not null references public.albums (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  position int not null default 0,
  is_public boolean not null default false,
  audience_id uuid references public.audiences (id) on delete cascade,
  epoch int,
  envelope jsonb not null check (octet_length(envelope::text) < 16384),   -- caption, file keys, tags, size
  created_at timestamptz not null default now(),
  check ((is_public and audience_id is null and epoch is null) or (not is_public and audience_id is not null and epoch is not null))
);
create index photos_album on public.photos (album_id, position);
alter table public.photos enable row level security;

create function kw.can_read_item(owner uuid, is_public boolean, aud uuid, u uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select owner = u
      or (not kw.is_blocked(u, owner) and
          case when is_public then kw.public_enabled() else kw.is_member(aud, u) end)
$$;

create function kw.can_write_item(owner uuid, is_public boolean, aud uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select owner = auth.uid() and kw.is_active()
     and case when is_public then kw.public_enabled()
              else exists (select 1 from public.audiences a where a.id = aud and a.owner_id = auth.uid()
                           and a.kind in ('friends', 'list', 'self')) end
$$;

create policy "read albums" on public.albums for select to authenticated
  using (kw.can_read_item(owner_id, is_public, audience_id));
create policy "write own albums" on public.albums for insert to authenticated
  with check (kw.can_write_item(owner_id, is_public, audience_id));
create policy "update own albums" on public.albums for update to authenticated
  using (owner_id = auth.uid()) with check (kw.can_write_item(owner_id, is_public, audience_id));
create policy "delete own albums" on public.albums for delete to authenticated
  using (owner_id = auth.uid() or kw.is_staff());

create policy "read photos" on public.photos for select to authenticated
  using (kw.can_read_item(owner_id, is_public, audience_id));
create policy "write own photos" on public.photos for insert to authenticated
  with check (kw.can_write_item(owner_id, is_public, audience_id)
              and exists (select 1 from public.albums a where a.id = album_id and a.owner_id = auth.uid()));
create policy "update own photos" on public.photos for update to authenticated
  using (owner_id = auth.uid()) with check (kw.can_write_item(owner_id, is_public, audience_id));
create policy "delete own photos" on public.photos for delete to authenticated
  using (owner_id = auth.uid() or kw.is_staff());

create function kw.can_read_photo(ph uuid, u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.photos p where p.id = ph
                 and kw.can_read_item(p.owner_id, p.is_public, p.audience_id, u))
$$;

-- Photo tag notices: lets a tagged friend be notified and approve/remove the tag.
create table public.tag_notices (
  photo_id uuid not null references public.photos (id) on delete cascade,
  tagged_id uuid not null references public.profiles (id) on delete cascade,
  tagger_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'removed')),
  created_at timestamptz not null default now(),
  primary key (photo_id, tagged_id)
);
create index tag_notices_tagged on public.tag_notices (tagged_id, created_at desc);
alter table public.tag_notices enable row level security;
create policy "parties see tag notices" on public.tag_notices for select to authenticated
  using (auth.uid() in (tagged_id, tagger_id)
         or exists (select 1 from public.photos p where p.id = photo_id and p.owner_id = auth.uid()));
create policy "tag a friend in a photo you can see" on public.tag_notices for insert to authenticated
  with check (tagger_id = auth.uid() and kw.can_read_photo(photo_id)
              and (tagged_id = auth.uid() or kw.is_friend(auth.uid(), tagged_id)) and status = 'pending');
create policy "tagged person or photo owner updates" on public.tag_notices for update to authenticated
  using (tagged_id = auth.uid() or exists (select 1 from public.photos p where p.id = photo_id and p.owner_id = auth.uid()))
  with check (tagged_id = auth.uid() or exists (select 1 from public.photos p where p.id = photo_id and p.owner_id = auth.uid()));
create policy "parties delete tag notices" on public.tag_notices for delete to authenticated
  using (auth.uid() in (tagged_id, tagger_id)
         or exists (select 1 from public.photos p where p.id = photo_id and p.owner_id = auth.uid()));

-- Comments ---------------------------------------------------------------------------
create table public.comments (
  id uuid primary key,
  post_id uuid references public.posts (id) on delete cascade,
  photo_id uuid references public.photos (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  envelope jsonb not null check (octet_length(envelope::text) < 8192),
  created_at timestamptz not null default now(),
  check (num_nonnulls(post_id, photo_id) = 1)
);
create index comments_post on public.comments (post_id, created_at) where post_id is not null;
create index comments_photo on public.comments (photo_id, created_at) where photo_id is not null;
alter table public.comments enable row level security;

create function kw.can_read_comment_parent(post uuid, photo uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when post is not null then kw.can_read_post(post) else kw.can_read_photo(photo) end
$$;

create policy "read comments on readable items" on public.comments for select to authenticated
  using (kw.can_read_comment_parent(post_id, photo_id));
create policy "comment on readable items" on public.comments for insert to authenticated
  with check (author_id = auth.uid() and kw.is_active() and kw.can_read_comment_parent(post_id, photo_id));
create policy "author or item owner deletes comment" on public.comments for delete to authenticated
  using (author_id = auth.uid() or kw.is_staff()
         or exists (select 1 from public.posts p where p.id = post_id and auth.uid() in (p.author_id, p.wall_owner_id))
         or exists (select 1 from public.photos p where p.id = photo_id and p.owner_id = auth.uid()));

create function kw.comments_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('comment', 1000, interval '1 day');
  new.created_at := now();
  return new;
end $$;
create trigger comments_guard before insert on public.comments
  for each row execute function kw.comments_guard();

-- Likes (posts, comments, photos) ---------------------------------------------------
create table public.likes (
  target_kind text not null check (target_kind in ('post', 'comment', 'photo')),
  target_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (target_kind, target_id, user_id)
);
create index likes_user on public.likes (user_id);
alter table public.likes enable row level security;

create function kw.can_read_target(kind text, target uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  if kind = 'post' then return kw.can_read_post(target);
  elsif kind = 'photo' then return kw.can_read_photo(target);
  elsif kind = 'comment' then
    select post_id, photo_id into c from public.comments where id = target;
    if not found then return false; end if;
    return kw.can_read_comment_parent(c.post_id, c.photo_id);
  end if;
  return false;
end $$;

create policy "see likes on readable items" on public.likes for select to authenticated
  using (kw.can_read_target(target_kind, target_id));
create policy "like readable items" on public.likes for insert to authenticated
  with check (user_id = auth.uid() and kw.is_active() and kw.can_read_target(target_kind, target_id));
create policy "unlike" on public.likes for delete to authenticated using (user_id = auth.uid());

-- Poll votes (Questions) — encrypted with a subkey of the question's content key.
create table public.poll_votes (
  post_id uuid not null references public.posts (id) on delete cascade,
  voter_id uuid not null references public.profiles (id) on delete cascade,
  envelope jsonb not null check (octet_length(envelope::text) < 2048),
  created_at timestamptz not null default now(),
  primary key (post_id, voter_id)
);
alter table public.poll_votes enable row level security;
create policy "see votes on readable polls" on public.poll_votes for select to authenticated
  using (kw.can_read_post(post_id));
create policy "vote on readable polls" on public.poll_votes for insert to authenticated
  with check (voter_id = auth.uid() and kw.can_read_post(post_id)
              and exists (select 1 from public.posts p where p.id = post_id and p.kind = 'question'));
create policy "change own vote" on public.poll_votes for update to authenticated
  using (voter_id = auth.uid()) with check (voter_id = auth.uid());
create policy "remove own vote" on public.poll_votes for delete to authenticated using (voter_id = auth.uid());

-- Encrypted profile information (one envelope per audience the owner shares it with).
create table public.profile_info (
  user_id uuid not null references public.profiles (id) on delete cascade,
  audience_id uuid not null references public.audiences (id) on delete cascade,
  epoch int not null,
  envelope jsonb not null check (octet_length(envelope::text) < 65536),
  updated_at timestamptz not null default now(),
  primary key (user_id, audience_id)
);
alter table public.profile_info enable row level security;
create policy "read profile info you're entitled to" on public.profile_info for select to authenticated
  using (user_id = auth.uid() or (not kw.is_blocked(auth.uid(), user_id) and kw.is_member(audience_id)));
create policy "owner writes profile info" on public.profile_info for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and kw.audience_owner(audience_id) = auth.uid());

-- Media objects: maps a storage object path to the row that grants access to it.
create table public.media_objects (
  path text primary key check (path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}(-[a-z0-9]+)?$'),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  post_id uuid references public.posts (id) on delete cascade,
  photo_id uuid references public.photos (id) on delete cascade,
  message_id uuid,                                  -- FK added with messages
  profile_avatar boolean not null default false,    -- readable by owner's friends
  bytes int not null check (bytes > 0 and bytes <= 31457280),
  created_at timestamptz not null default now(),
  check (num_nonnulls(post_id, photo_id, message_id) <= 1),
  check (split_part(path, '/', 1) = owner_id::text)
);
alter table public.media_objects enable row level security;

-- Readability of a media object is decided by the row it belongs to.
create function kw.can_read_media(object_path text, u uuid default auth.uid()) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare m record;
begin
  select * into m from public.media_objects where path = object_path;
  if not found then return false; end if;
  if m.owner_id = u then return true; end if;
  if kw.is_blocked(u, m.owner_id) then return false; end if;
  if m.post_id is not null then return kw.can_read_post(m.post_id, u); end if;
  if m.photo_id is not null then return kw.can_read_photo(m.photo_id, u); end if;
  if m.message_id is not null then
    return exists (select 1 from public.messages x join public.conversations c on c.id = x.conversation_id
                   where x.id = m.message_id and kw.is_member(c.audience_id, u));
  end if;
  if m.profile_avatar then return kw.is_friend(m.owner_id, u); end if;
  return false;
end $$;

create policy "read media you're entitled to" on public.media_objects for select to authenticated
  using (kw.can_read_media(path));
create policy "owner registers media" on public.media_objects for insert to authenticated
  with check (owner_id = auth.uid() and kw.is_active());
create policy "owner updates media links" on public.media_objects for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owner deletes media" on public.media_objects for delete to authenticated
  using (owner_id = auth.uid() or kw.is_staff());
