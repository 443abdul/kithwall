-- Kithwall core: helper schema, settings, staff, profiles, key storage, rate limiting.
-- Content is end-to-end encrypted on clients; tables store ciphertext envelopes (jsonb)
-- plus the minimum routing metadata. Every table has RLS enabled and deny-by-default.

create extension if not exists citext with schema extensions;

-- Private helper schema: callable from policies, not exposed through the Data API.
create schema if not exists kw;
revoke all on schema kw from public;
grant usage on schema kw to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- App settings (operator switches such as enabling the Public audience)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value) values
  ('public_audience_enabled', 'false'::jsonb),
  ('signups_enabled', 'true'::jsonb);

-- ---------------------------------------------------------------------------
-- Staff (admins appoint moderators; admins are bootstrapped by the owner in SQL)
-- ---------------------------------------------------------------------------
create table public.staff_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'moderator')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;

create function kw.is_staff(u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_roles s where s.user_id = u)
$$;

create function kw.is_admin(u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_roles s where s.user_id = u and s.role = 'admin')
$$;

create function kw.setting(k text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select value from public.app_settings where key = k
$$;

create function kw.public_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value)::text = 'true' from public.app_settings where key = 'public_audience_enabled'), false)
$$;

create policy "settings readable by signed-in users" on public.app_settings
  for select to authenticated using (true);
create policy "settings writable by admins" on public.app_settings
  for update to authenticated using (kw.is_admin()) with check (kw.is_admin());

create policy "staff see staff list; users see own role" on public.staff_roles
  for select to authenticated using (user_id = auth.uid() or kw.is_staff());

-- Admin-only RPCs to appoint or remove staff.
create function public.grant_staff_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  if new_role not in ('admin', 'moderator') then raise exception 'invalid role'; end if;
  insert into public.staff_roles (user_id, role, granted_by) values (target, new_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role, granted_by = excluded.granted_by, created_at = now();
end $$;

create function public.revoke_staff_role(target uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not kw.is_admin() then raise exception 'not authorised' using errcode = '42501'; end if;
  if target = auth.uid() then raise exception 'admins cannot remove themselves'; end if;
  delete from public.staff_roles where user_id = target;
end $$;

-- ---------------------------------------------------------------------------
-- Rate limiting (enforced by BEFORE INSERT triggers)
-- ---------------------------------------------------------------------------
create table kw.rate_events (
  user_id uuid not null,
  action text not null,
  at timestamptz not null default now()
);
create index rate_events_lookup on kw.rate_events (user_id, action, at desc);

create function kw.rate_limit(action text, max_count int, per interval) returns void
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then return; end if; -- service role / migrations
  select count(*) into n from kw.rate_events r
   where r.user_id = auth.uid() and r.action = rate_limit.action and r.at > now() - per;
  if n >= max_count then
    raise exception 'rate limit exceeded for %', action using errcode = 'P0429';
  end if;
  insert into kw.rate_events (user_id, action) values (auth.uid(), action);
end $$;

-- ---------------------------------------------------------------------------
-- Profiles: public routing data only. Real names and profile details live in
-- the encrypted profile_info envelope. display_name_public is only set by users
-- who opt into the people directory.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username extensions.citext not null unique
    check (username ~ '^[a-z0-9][a-z0-9.]{2,29}$'),
  discoverable boolean not null default false,
  display_name_public text check (char_length(display_name_public) between 1 and 80),
  sign_pub text not null check (char_length(sign_pub) = 43),
  kx_pub text not null check (char_length(kx_pub) = 43),
  key_version int not null default 1,
  status text not null default 'active' check (status in ('active', 'suspended', 'banned')),
  suspended_until timestamptz,
  created_at timestamptz not null default now(),
  constraint directory_name_only_when_discoverable
    check (discoverable or display_name_public is null)
);
alter table public.profiles enable row level security;

create function kw.is_active(u uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = u and (p.status = 'active' or (p.status = 'suspended' and p.suspended_until < now()))
  )
$$;

-- ---------------------------------------------------------------------------
-- Key bundle (owner only) and signed key-change log
-- ---------------------------------------------------------------------------
create table public.key_bundles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  bundle jsonb not null check (octet_length(bundle::text) < 8192),
  updated_at timestamptz not null default now()
);
alter table public.key_bundles enable row level security;
create policy "owner reads bundle" on public.key_bundles
  for select to authenticated using (user_id = auth.uid());
create policy "owner creates bundle" on public.key_bundles
  for insert to authenticated with check (user_id = auth.uid());
create policy "owner updates bundle" on public.key_bundles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.key_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  change jsonb not null,
  sig text not null,
  created_at timestamptz not null default now()
);
alter table public.key_changes enable row level security;
create policy "key changes readable by signed-in users" on public.key_changes
  for select to authenticated using (true);
create policy "owner records own key change" on public.key_changes
  for insert to authenticated with check (user_id = auth.uid());

-- Proof-of-key challenges (spec §3.9); verified by a server route with the secret key.
create table public.key_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  nonce text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  purpose text not null check (purpose in ('delete_account', 'delete_all_posts', 'change_recovery')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.key_challenges enable row level security;
create policy "owner reads own challenges" on public.key_challenges
  for select to authenticated using (user_id = auth.uid());

create function public.create_key_challenge(purpose text) returns table (id uuid, nonce text)
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.rate_limit('key_challenge', 20, interval '1 hour');
  return query insert into public.key_challenges (user_id, purpose)
    values (auth.uid(), create_key_challenge.purpose)
    returning key_challenges.id, key_challenges.nonce;
end $$;

-- ---------------------------------------------------------------------------
-- Private vault (settings, list names, game state) — one encrypted blob per user
-- ---------------------------------------------------------------------------
create table public.vault (
  user_id uuid primary key references auth.users (id) on delete cascade,
  blob text not null check (char_length(blob) < 1048576),
  updated_at timestamptz not null default now()
);
alter table public.vault enable row level security;
create policy "owner manages vault" on public.vault
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Lock down default privileges: nothing for anon on these tables.
revoke all on all tables in schema public from anon;
