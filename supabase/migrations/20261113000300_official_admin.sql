-- Kithwall 2: the operator runs the automated accounts from the Admin screen (docs/v2/13-official-accounts.md §5).
--
--  * The accounts are data now (official_account_defs), not a list in the code: an admin can add one
--    (@kithwall.<name>), and remove one that was never used.
--  * An admin can add a source of their own (an RSS or Atom feed, or a YouTube channel). The server checks the
--    address before it is stored (https, a public host, a feed that really parses) in /api/official/sources;
--    such sources show the headline and a link (or, if the admin says the publisher allows it, the feed's own
--    summary), never pictures. Built-in sources keep the terms a migration gave them.
--  * Each source's posts-a-day is the admin's to set (1 to 24), and "Post now" posts what is new at once,
--    whatever was posted earlier today.
--  * An automated account may make up to 300 public posts a day (a person: 20), since the limits above are
--    what really holds it.

-- ---------------------------------------------------------------------------------------
-- 1. Accounts
-- ---------------------------------------------------------------------------------------
create table public.official_account_defs (
  slug text primary key check (slug ~ '^[a-z]{2,20}$'),
  handle text not null unique,
  name text not null check (char_length(btrim(name)) between 2 and 60),
  custom boolean not null default true,
  created_at timestamptz not null default now(),
  check (handle = 'kithwall.' || slug)
);
alter table public.official_account_defs enable row level security;
create policy "staff read official account definitions" on public.official_account_defs for select to authenticated
  using (kw.is_staff());

insert into public.official_account_defs (slug, handle, name, custom) values
  ('learn', 'kithwall.learn', 'Kithwall Learn', false),
  ('science', 'kithwall.science', 'Kithwall Science', false),
  ('news', 'kithwall.news', 'Kithwall News', false),
  ('urdu', 'kithwall.urdu', 'Kithwall اردو', false);

create function public.add_official_account(p_handle text, p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare h text := lower(regexp_replace(btrim(coalesce(p_handle, '')), '^@+', '')); s text;
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'admins only' using errcode = '42501'; end if;
  if h !~ '^kithwall\.[a-z]{2,20}$' then
    raise exception 'the handle is kithwall. followed by 2 to 20 letters' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_name)), 0) not between 2 and 60 then
    raise exception 'the name has 2 to 60 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.official_account_defs) >= 20 then
    raise exception 'at most 20 automated accounts' using errcode = '22023';
  end if;
  s := substr(h, 10);
  insert into public.official_account_defs (slug, handle, name) values (s, h, btrim(p_name));
  return s;
end $$;

-- An account that already exists as a profile is not removed here (its posts are public record; a moderator
-- deals with it like any account). One that was only defined, and has no sources, can go.
create function public.remove_official_account(p_slug text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'admins only' using errcode = '42501'; end if;
  if exists (select 1 from public.official_accounts o where o.slug = p_slug) then
    raise exception 'this account has already posted' using errcode = '22023';
  end if;
  if exists (select 1 from public.official_sources s where s.account = p_slug) then
    raise exception 'remove its sources first' using errcode = '22023';
  end if;
  delete from public.official_account_defs where slug = p_slug and custom;
  if not found then raise exception 'no such account, or it is built in' using errcode = 'P0002'; end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- 2. Sources
-- ---------------------------------------------------------------------------------------
alter table public.official_sources add column custom boolean not null default false;
alter table public.official_sources drop constraint official_sources_per_day_check;
alter table public.official_sources add constraint official_sources_per_day_check check (per_day between 1 and 24);
alter table public.official_sources add constraint official_sources_account_fkey
  foreign key (account) references public.official_account_defs (slug);
-- A source an admin added: a feed or a channel, and never more than the headline or the feed's summary.
alter table public.official_sources add constraint official_sources_custom_terms
  check (not custom or (kind in ('rss', 'youtube') and terms in ('headline', 'summary', 'embed')));

-- The World Health Organization's news feed stopped being updated (its newest items are from 2020), so the
-- source never had anything to post. Its replacement, if any, is an admin's to add.
delete from public.official_sources where id = 'who-news';

create function public.set_official_source_rate(p_id text, p_per_day int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'admins only' using errcode = '42501'; end if;
  if p_per_day is null or p_per_day not between 1 and 24 then
    raise exception 'between 1 and 24 posts a day' using errcode = '22023';
  end if;
  update public.official_sources set per_day = p_per_day where id = p_id;
  if not found then raise exception 'no such source' using errcode = 'P0002'; end if;
end $$;

create function public.remove_official_source(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'admins only' using errcode = '42501'; end if;
  delete from public.official_sources where id = p_id and custom;
  if not found then raise exception 'no such source, or it is built in' using errcode = 'P0002'; end if;
end $$;

revoke execute on function public.add_official_account(text, text), public.remove_official_account(text),
  public.set_official_source_rate(text, int), public.remove_official_source(text) from public, anon;
grant execute on function public.add_official_account(text, text), public.remove_official_account(text),
  public.set_official_source_rate(text, int), public.remove_official_source(text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 3. An automated account's daily ceiling
-- ---------------------------------------------------------------------------------------
-- kw.posts_guard as in 20261112000100_follow_public.sql; only the Public-post limit differs for automated
-- accounts (300 a day instead of 20).
create or replace function kw.posts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare scheduled boolean;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('post', 300, interval '1 day');
    if new.is_public and new.wall_owner_id is not null then
      perform kw.rate_limit('public_post', case when kw.is_official(auth.uid()) then 300 else 20 end, interval '1 day');
    end if;
    new.public_hidden_at := null;
    new.public_reviewed_at := null;
    new.edited_at := null;
    if new.publish_at is not null and new.publish_at <= now() + interval '1 minute' then new.publish_at := null; end if;
    if new.publish_at is not null then
      if new.publish_at > now() + interval '366 days' then
        raise exception 'posts can be scheduled up to a year ahead' using errcode = '22023';
      end if;
      perform kw.rate_limit('post_schedule', 100, interval '1 day');
      new.created_at := new.publish_at;
    else
      new.created_at := now();
    end if;
    new.expires_at := case when new.disappear_secs is null then null else new.created_at + make_interval(secs => new.disappear_secs) end;
    return new;
  end if;

  if new.id <> old.id or new.author_id <> old.author_id
     or new.wall_owner_id is distinct from old.wall_owner_id or new.group_id is distinct from old.group_id
     or new.event_id is distinct from old.event_id
     or new.kind <> old.kind then
    raise exception 'post identity is immutable';
  end if;

  if (new.public_hidden_at is distinct from old.public_hidden_at or new.public_reviewed_at is distinct from old.public_reviewed_at)
     and coalesce(current_setting('kw.public_moderation', true), '') <> 'on' then
    raise exception 'only moderation hides or restores a public post' using errcode = '42501';
  end if;
  -- A post made Public later counts against the same limit as a new Public post.
  if new.is_public and not old.is_public and new.wall_owner_id is not null then
    perform kw.rate_limit('public_post', case when kw.is_official(auth.uid()) then 300 else 20 end, interval '1 day');
  end if;

  -- The scheduler (pg_cron, no user): marks a due post published. Nothing else changes.
  if auth.uid() is null and new.publish_at is null and old.publish_at is not null and old.publish_at <= now()
     and new.envelope = old.envelope then
    new.created_at := old.created_at;
    new.edited_at := old.edited_at;
    new.expires_at := old.expires_at;
    return new;
  end if;

  scheduled := old.publish_at is not null and old.publish_at > now();
  if scheduled then
    if new.publish_at is null or new.publish_at <= now() then        -- "publish now"
      new.publish_at := null;
      new.created_at := now();
    elsif new.publish_at is distinct from old.publish_at then         -- rescheduled
      if new.publish_at > now() + interval '366 days' then
        raise exception 'posts can be scheduled up to a year ahead' using errcode = '22023';
      end if;
      new.created_at := new.publish_at;
    else
      new.created_at := old.created_at;
    end if;
    new.edited_at := null;                                            -- nobody has seen it yet
  else
    if new.created_at <> old.created_at
       or (new.publish_at is distinct from old.publish_at and new.publish_at is not null) then
      raise exception 'post identity is immutable';
    end if;
    new.edited_at := case when new.envelope is distinct from old.envelope then now() else old.edited_at end;
  end if;
  -- An edited public post is new content: a moderator's earlier "this may stay" no longer covers it.
  if new.envelope is distinct from old.envelope then new.public_reviewed_at := null; end if;
  new.expires_at := case when new.disappear_secs is null then null else new.created_at + make_interval(secs => new.disappear_secs) end;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------
-- 4. Data map
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.official_account_defs', 'system', null, 'created_at', null, 'kept',
   'The automated accounts the operator defined: handle and public name. Nothing about people.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.official_account_defs', 'slug', 'id', 'short name of the account'),
  ('public.official_account_defs', 'handle', 'plaintext', 'its @handle'),
  ('public.official_account_defs', 'name', 'plaintext', 'its public name'),
  ('public.official_account_defs', 'custom', 'plaintext', 'added by an admin (not built in)'),
  ('public.official_account_defs', 'created_at', 'time', null),
  ('public.official_sources', 'custom', 'plaintext', 'added by an admin (not built in)');
