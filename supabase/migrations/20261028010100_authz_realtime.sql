-- Security review D1 (docs/v2/06-security-review.md): Realtime DELETE events bypass RLS.
--
-- Supabase Realtime applies RLS to INSERT and UPDATE events, but not to DELETE events: every subscriber
-- to a published table receives the old row's primary key. For friendships(user_a, user_b),
-- pokes(from_id, to_id), likes(target_kind, target_id, user_id), audience_keys(audience_id, epoch,
-- recipient_id) and message_reactions(message_id, user_id) the primary key IS the relationship, so any
-- signed-in user could watch unfriending, blocking, unliking and key churn across the whole service.
--
-- Fix:
--  1. The supabase_realtime publication no longer publishes DELETE at all (realtime.list_changes reads
--     pubdelete). INSERT and UPDATE events still flow and are filtered by RLS per subscriber. This also
--     covers any table published later.
--  2. pokes leaves the publication (no client listens to it).
--  3. The few deletes a client does want to hear about live (an unfriend, an unlike) are sent as a
--     content-free broadcast on the private topic "db:<user id>", which only that user may receive
--     (Realtime Authorization on realtime.messages; no client may send on it). Everything else is
--     picked up by the normal refetch (window focus / query invalidation).
--
-- Production: also turn on "Private channels only" in the Realtime settings (docs/v2/07-launch.md).

alter publication supabase_realtime set (publish = 'insert, update, truncate');

do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pokes') then
    execute 'alter publication supabase_realtime drop table public.pokes';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- Private "db:<uuid>" topic: only that user receives; clients never send.
-- ---------------------------------------------------------------------------------------
create function kw.db_topic_owner(topic text) returns uuid
language sql immutable set search_path = '' as $$
  select case when topic ~ '^db:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(topic, 4)::uuid end
$$;

create policy "kw db: owner receives" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and kw.db_topic_owner((select realtime.topic())) = (select auth.uid())
  );

-- Tell one user that something of theirs changed (payload: the table name only). Never fails the
-- caller's statement: realtime.send itself turns errors into warnings.
create function kw.db_notify(u uuid, what text) returns void
language plpgsql security definer set search_path = '' as $$
declare saved text := current_setting('realtime.topic', true);
begin
  if u is null then return; end if;
  perform realtime.send(jsonb_build_object('t', what), 'change', 'db:' || u::text, true);
  -- realtime.send does SET LOCAL realtime.topic; put it back so policies later in this transaction
  -- (e.g. a broadcast insert on another topic) see the topic they expect.
  perform set_config('realtime.topic', coalesce(saved, ''), true);
end $$;

create function kw.friendships_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.db_notify(old.user_a, 'friendships');
  perform kw.db_notify(old.user_b, 'friendships');
  return null;
end $$;
create trigger friendships_deleted after delete on public.friendships
  for each row execute function kw.friendships_deleted();

-- An unlike: the person who liked (their other devices) and the owner of the liked item.
create function kw.likes_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  if old.target_kind = 'post' then select author_id into owner from public.posts where id = old.target_id;
  elsif old.target_kind = 'comment' then select author_id into owner from public.comments where id = old.target_id;
  elsif old.target_kind = 'photo' then select owner_id into owner from public.photos where id = old.target_id;
  end if;
  perform kw.db_notify(old.user_id, 'likes');
  if owner is not null and owner <> old.user_id then perform kw.db_notify(owner, 'likes'); end if;
  return null;
end $$;
create trigger likes_deleted after delete on public.likes
  for each row execute function kw.likes_deleted();

revoke execute on function kw.db_topic_owner(text), kw.db_notify(uuid, text), kw.friendships_deleted(), kw.likes_deleted()
  from public, anon, authenticated;
grant execute on function kw.db_topic_owner(text) to authenticated, service_role;
