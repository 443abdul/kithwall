-- Kithwall 2: official, automated accounts (docs/v2/13-official-accounts.md).
--
-- A few accounts run by Kithwall itself post PUBLIC posts from sources that allow it (Wikipedia, NASA, UN
-- News, educational YouTube channels through YouTube's own player), so Explore is not empty for someone who
-- just joined. They are ordinary accounts in every way that matters for trust:
--
--  * every post is a normal Public post: signed by the account's own key, labelled Public, reportable,
--    hidden after reports like any other, removable by moderators;
--  * the accounts are marked: `public.automated_accounts()` lists them for everyone, and the app shows an
--    "Automated" badge wherever one of them appears. Only the service role can add to that list;
--  * nobody can register a handle that starts with "kithwall" any more, so the badge cannot be imitated;
--  * they cannot be sent connection requests (nobody would answer), only followed;
--  * nothing here reads or touches anyone's private content: the job only writes public posts.
--
-- The job that posts is apps/web/src/app/api/cron/official (once a day; posts are spread over the day with
-- publish_at). It does nothing until the operator sets KITHWALL_OFFICIAL_SEED, and stops when the operator
-- switches "Official accounts" off or switches a source off.

-- ---------------------------------------------------------------------------------------
-- 1. Operator switch
-- ---------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values ('official_accounts_enabled', 'true'::jsonb)
on conflict (key) do nothing;

create function kw.app_settings_official_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'official_accounts_enabled' and jsonb_typeof(new.value) <> 'boolean' then
    raise exception '% must be true or false', new.key using errcode = '22023';
  end if;
  return new;
end $$;
create trigger app_settings_official_guard before insert or update on public.app_settings
  for each row execute function kw.app_settings_official_guard();

-- ---------------------------------------------------------------------------------------
-- 2. The accounts
-- ---------------------------------------------------------------------------------------
create table public.official_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z]{2,20}$'),
  created_at timestamptz not null default now()
);
alter table public.official_accounts enable row level security;   -- no policies: the service role only

create function kw.is_official(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.official_accounts o where o.user_id = u)
$$;
revoke execute on function kw.is_official(uuid) from public, anon;
grant execute on function kw.is_official(uuid) to authenticated, service_role;

-- Who is automated: public, so the badge works with or without an account.
create function public.automated_accounts()
returns table (id uuid, username text, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username::text, p.display_name_public
    from public.official_accounts o join public.profiles p on p.id = o.user_id
   where kw.is_active(p.id)
   order by o.created_at
$$;
revoke execute on function public.automated_accounts() from public;
grant execute on function public.automated_accounts() to anon, authenticated, service_role;

-- Handles that start with "kithwall" belong to Kithwall: only create_official_account may use them.
create function kw.profiles_official_prefix() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.username::text) like 'kithwall%'
     and (tg_op = 'INSERT' or lower(old.username::text) is distinct from lower(new.username::text))
     and coalesce(current_setting('kw.official_create', true), '') <> 'on' then
    raise exception 'this handle is reserved' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger profiles_official_prefix before insert or update of username on public.profiles
  for each row execute function kw.profiles_official_prefix();

-- Creates one official account. The auth user already exists (made by the job with the secret key), and the
-- key bundle was made by the job: its account key is wrapped under a key derived from the operator's seed, so
-- only the job can sign as this account, and nobody can sign in to it (the auth user has a random password
-- and no passkey).
create function public.create_official_account(p_user uuid, p_slug text, p_handle text, p_name text, p_bundle jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not (p_bundle ? 'amkByPassword') then
    raise exception 'an official account needs a wrapped account key' using errcode = '22023';
  end if;
  if lower(p_handle) not like 'kithwall.%' then
    raise exception 'official handles start with "kithwall."' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_name)), 0) not between 2 and 60 then
    raise exception 'an official account needs a public name' using errcode = '22023';
  end if;
  perform set_config('kw.official_create', 'on', true);
  perform public.create_passkey_account(p_user, p_handle, p_bundle);
  perform set_config('kw.official_create', '', true);
  -- Public name and follow together: each is only allowed with the other.
  update public.profiles set display_name_public = btrim(p_name), follow_enabled = true where id = p_user;
  insert into public.privacy_prefs (user_id, index_public, mention_policy, requests_from)
    values (p_user, true, 'nobody', 'nobody')
    on conflict (user_id) do update set index_public = true, mention_policy = 'nobody', requests_from = 'nobody';
  insert into public.official_accounts (user_id, slug) values (p_user, p_slug);
  return p_user;
end $$;
revoke execute on function public.create_official_account(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_official_account(uuid, text, text, text, jsonb) to service_role;

-- An official account posts publicly from its first minute (the 24-hour wait is there for strangers).
create or replace function kw.may_post_public(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select kw.public_posts_on()
     and exists (select 1 from public.profiles p
                  where p.id = u and p.follow_enabled
                    and (kw.is_official(u)
                         or p.created_at <= now() - make_interval(hours => kw.setting_int('public_post_min_age_hours', 24))))
$$;

-- Nobody answers a connection request sent to an automated account: refuse it, the app offers Follow.
create function kw.friendships_no_official() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if kw.is_official(new.user_a) or kw.is_official(new.user_b) then
    raise exception 'automated accounts can be followed, not connected with' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger friendships_no_official before insert on public.friendships
  for each row execute function kw.friendships_no_official();

-- ---------------------------------------------------------------------------------------
-- 3. Sources
-- ---------------------------------------------------------------------------------------
-- What each source lets us show (`terms`):
--   public-domain  text and pictures may be shown in full, with credit (NASA)
--   cc             free licence: an excerpt and, where the file's own licence allows, the picture, with the
--                  author and the licence named (Wikipedia, Wikimedia Commons, Our World in Data)
--   summary        the headline and the short summary the publisher puts in its own feed, with a link
--   headline       the headline and a link, nothing else
--   embed          a link that plays in the publisher's own player (YouTube); nothing is copied
-- The address of a source is fixed here: the admin screen can switch a source on or off, never point it
-- somewhere else.
create table public.official_sources (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  account text not null check (account ~ '^[a-z]{2,20}$'),
  kind text not null check (kind in ('rss', 'youtube', 'wikipedia', 'nasa-image')),
  title text not null check (char_length(title) between 2 and 80),
  url text not null check (url ~ '^https://'),
  lang text not null default 'en' check (lang ~ '^[a-z]{2}$'),
  terms text not null check (terms in ('public-domain', 'cc', 'summary', 'headline', 'embed')),
  per_day int not null default 2 check (per_day between 1 and 6),
  -- Items whose title matches are left out: a part of a feed that comes under different terms.
  skip_title text check (skip_title is null or char_length(skip_title) <= 200),
  enabled boolean not null default false,
  position int not null default 0,
  last_run_at timestamptz,
  last_posted_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300)
);
alter table public.official_sources enable row level security;
create policy "staff read official sources" on public.official_sources for select to authenticated
  using (kw.is_staff());

create function public.set_official_source(p_id text, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'admins only' using errcode = '42501'; end if;
  update public.official_sources set enabled = coalesce(p_enabled, false) where id = p_id;
  if not found then raise exception 'no such source' using errcode = 'P0002'; end if;
end $$;
revoke execute on function public.set_official_source(text, boolean) from public, anon;
grant execute on function public.set_official_source(text, boolean) to authenticated;

-- Sources whose terms clearly allow this use start switched on; publishers that only offer a feed start off,
-- for the operator to decide.
insert into public.official_sources (id, account, kind, title, url, lang, terms, per_day, enabled, position) values
  ('wikipedia-en',     'learn',   'wikipedia',  'Wikipedia',                 'https://api.wikimedia.org/feed/v1/wikipedia/en/featured/', 'en', 'cc', 4, true, 10),
  ('nasa-iotd',        'science', 'nasa-image', 'NASA Image of the Day',     'https://www.nasa.gov/feeds/iotd-feed/', 'en', 'public-domain', 1, true, 20),
  ('nasa-news',        'science', 'rss',        'NASA',                      'https://www.nasa.gov/news-release/feed/', 'en', 'public-domain', 2, true, 21),
  ('owid',             'science', 'rss',        'Our World in Data',         'https://ourworldindata.org/atom.xml', 'en', 'cc', 1, true, 22),
  ('yt-kurzgesagt',    'science', 'youtube',    'Kurzgesagt – In a Nutshell', 'https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37bltHxD1rDPwtNM8Q', 'en', 'embed', 1, true, 30),
  ('yt-veritasium',    'science', 'youtube',    'Veritasium',                'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA', 'en', 'embed', 1, true, 31),
  ('yt-ted-ed',        'learn',   'youtube',    'TED-Ed',                    'https://www.youtube.com/feeds/videos.xml?channel_id=UCsooa4yRKGN_zEE8iknghZA', 'en', 'embed', 1, true, 32),
  ('yt-crashcourse',   'learn',   'youtube',    'CrashCourse',               'https://www.youtube.com/feeds/videos.xml?channel_id=UCX6b17PVsYBQ0ip5gyeme-Q', 'en', 'embed', 1, true, 33),
  ('yt-khan',          'learn',   'youtube',    'Khan Academy',              'https://www.youtube.com/feeds/videos.xml?channel_id=UC4a-Gbdw7vOaccHmFo40b9g', 'en', 'embed', 1, true, 34),
  ('un-news-en',       'news',    'rss',        'UN News',                   'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 'en', 'summary', 3, true, 40),
  ('who-news',         'news',    'rss',        'World Health Organization', 'https://www.who.int/rss-feeds/news-english.xml', 'en', 'summary', 1, true, 41),
  ('bbc-world',        'news',    'rss',        'BBC News',                  'https://feeds.bbci.co.uk/news/world/rss.xml', 'en', 'headline', 3, false, 42),
  ('dawn',             'news',    'rss',        'Dawn',                      'https://www.dawn.com/feeds/home', 'en', 'headline', 3, false, 43),
  ('un-news-ur',       'urdu',    'rss',        'یو این نیوز',                'https://news.un.org/feed/subscribe/ur/news/all/rss.xml', 'ur', 'summary', 4, true, 50),
  ('bbc-urdu',         'urdu',    'rss',        'بی بی سی اردو',              'https://feeds.bbci.co.uk/urdu/rss.xml', 'ur', 'headline', 3, false, 51);

-- NASA's news feed carries the Astronomy Picture of the Day, whose pictures often belong to their
-- photographers and are not in the public domain: left out.
update public.official_sources set skip_title = '^APOD:' where id = 'nasa-news';

-- What was already posted, so nothing is posted twice. `item_key` is a hash of the item's own address.
create table public.official_items (
  source_id text not null references public.official_sources (id) on delete cascade,
  item_key text not null check (item_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  post_id uuid references public.posts (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (source_id, item_key)
);
alter table public.official_items enable row level security;      -- no policies: the service role only
create index official_items_created on public.official_items (created_at);

-- Housekeeping, called by the job: nobody reads an automated account's notifications, and items older than
-- a year have long left every feed.
create function public.official_housekeeping() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.notifications n using public.official_accounts o where n.recipient_id = o.user_id;
  delete from public.official_items where created_at < now() - interval '400 days';
end $$;
revoke execute on function public.official_housekeeping() from public, anon, authenticated;
grant execute on function public.official_housekeeping() to service_role;

-- ---------------------------------------------------------------------------------------
-- 4. Data map ("What Kithwall knows")
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.official_accounts', 'system', null, 'created_at', null, 'while the account exists',
   'Which accounts are run by Kithwall itself and post automatically. Public: the app shows an "Automated" badge on them.'),
  ('public.official_sources', 'system', null, null, null, 'kept',
   'The public feeds the automated accounts post from, whether each is switched on, and when it last ran. Nothing about people.'),
  ('public.official_items', 'system', null, 'created_at', null, '400 days',
   'Which feed items were already posted by an automated account, so nothing is posted twice. Nothing about people.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.official_accounts', 'user_id', 'id', 'the automated account'),
  ('public.official_accounts', 'slug', 'plaintext', 'short name of the account in the job''s configuration'),
  ('public.official_accounts', 'created_at', 'time', null),
  ('public.official_sources', 'id', 'id', 'short name of the source'),
  ('public.official_sources', 'account', 'plaintext', 'which automated account posts it'),
  ('public.official_sources', 'kind', 'plaintext', 'feed format'),
  ('public.official_sources', 'title', 'plaintext', 'name of the publisher, shown as the source of each post'),
  ('public.official_sources', 'url', 'plaintext', 'address of the public feed'),
  ('public.official_sources', 'lang', 'plaintext', 'language of the feed'),
  ('public.official_sources', 'terms', 'plaintext', 'what the publisher allows to be shown'),
  ('public.official_sources', 'per_day', 'plaintext', 'most posts a day from this source'),
  ('public.official_sources', 'skip_title', 'plaintext', 'titles that are left out'),
  ('public.official_sources', 'enabled', 'plaintext', 'switched on by the operator'),
  ('public.official_sources', 'position', 'plaintext', 'order in the admin screen'),
  ('public.official_sources', 'last_run_at', 'time', 'when the feed was last read'),
  ('public.official_sources', 'last_posted_at', 'time', 'when something from it was last posted'),
  ('public.official_sources', 'last_error', 'plaintext', 'why the last read failed, if it did'),
  ('public.official_items', 'source_id', 'id', 'the source'),
  ('public.official_items', 'item_key', 'hashed', 'hash of the feed item''s address'),
  ('public.official_items', 'post_id', 'id', 'the public post made from it'),
  ('public.official_items', 'created_at', 'time', null);
