-- Kithwall 2 launch: "Kithwall Classic data" export (docs/v2/07-launch.md §5; lib/export.ts).
--
-- Before the v1-only tables are dropped (supabase/launch/drop_classic_tables.sql, 30 days after launch),
-- people download what Kithwall 2 no longer shows. Almost all of it is readable through the existing
-- policies (pokes, Kithville, poll votes, friend lists, own Pages). Two things are not: v1 Pages are public
-- data (name, category, about and Page posts are signed, not encrypted) that the policies only show while the
-- operator's Public switch is on (20261017000003), and Kithwall 2 leaves that switch off. These caller-only
-- functions return
--   * classic_liked_pages(): the Pages I liked (my like rows are already mine to read; this adds the names),
--   * classic_page_posts():  the posts on the Pages I own (including posts by others on them).
-- No new tables or columns (nothing to add to the data map). Dropped again by drop_classic_tables.sql.

create function public.classic_liked_pages()
returns table (id uuid, name text, category text, about text, liked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.category, p.about, l.created_at
    from public.page_likes l
    join public.pages p on p.id = l.page_id
   where l.user_id = auth.uid() and kw.mfa_ok()
   order by l.created_at
$$;

create function public.classic_page_posts()
returns setof public.posts
language sql stable security definer set search_path = '' as $$
  select x.*
    from public.posts x
    join public.pages p on p.id = x.page_id
   where p.owner_id = auth.uid() and kw.mfa_ok() and x.is_public
     and (x.publish_at is null or x.publish_at <= now())
     and (x.expires_at is null or x.expires_at > now())
   order by x.created_at
   limit 5000
$$;

revoke execute on function public.classic_liked_pages(), public.classic_page_posts() from public, anon;
grant execute on function public.classic_liked_pages(), public.classic_page_posts() to authenticated;
