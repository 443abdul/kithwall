-- Kithwall 2 accounts (docs/v2/01-accounts.md): passkey-first sign-up with no email and no password.
--
--  * passkeys            WebAuthn credentials (public key, signature counter, transports, label).
--                        Owner can read; only the server (secret key) writes. Removal goes through
--                        public.remove_passkey(), which refuses to remove the last way to unlock.
--  * passkey_wraps       Per-credential wrapped AMK: XChaCha20-Poly1305 under HKDF(PRF output, prf_salt).
--                        Opaque to the server (it never sees the PRF output or the AMK).
--  * passkey_users       The random WebAuthn user handle per account (server only).
--  * webauthn_challenges Short-lived, single-use ceremony challenges bound to an intent (server only).
--                        Also carries a keyed hash of the client IP for unauthenticated rate limits.
--  * account_security    Owner-readable account facts: recovery phrase saved, optional notice email.
--  * notice_email_verifications  Pending notice-email verification links (server only, hashed tokens).
--
-- Account creation is one server-side transaction (create_passkey_account) after the auth user exists.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.passkey_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- WebAuthn user.id: 32 random bytes, base64url. Not the Supabase user id (that would put the
  -- account id inside the authenticator, which other sites can't see but backups/exports can).
  webauthn_user_id text not null unique check (webauthn_user_id ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now()
);
alter table public.passkey_users enable row level security;
revoke all on public.passkey_users from anon, authenticated;

create table public.passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  credential_id text not null unique
    check (char_length(credential_id) between 16 and 1400 and credential_id ~ '^[A-Za-z0-9_-]+$'),
  public_key text not null                                                     -- COSE key, base64url
    check (char_length(public_key) between 16 and 2048 and public_key ~ '^[A-Za-z0-9_-]+$'),
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}' check (cardinality(transports) <= 8),
  backed_up boolean not null default false,
  label text not null default 'Passkey' check (char_length(label) between 1 and 60),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index passkeys_user on public.passkeys (user_id);
alter table public.passkeys enable row level security;
revoke all on public.passkeys from anon, authenticated;
grant select on public.passkeys to authenticated;
create policy "owner reads own passkeys" on public.passkeys for select to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.passkeys');

create table public.passkey_wraps (
  passkey_id uuid primary key references public.passkeys (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  prf_salt text not null check (prf_salt ~ '^[A-Za-z0-9_-]{43}$'),            -- 32 bytes
  amk_wrap text not null check (amk_wrap ~ '^[A-Za-z0-9_-]{90,120}$'),         -- 0x01 ‖ nonce ‖ AMK ‖ tag = 73 bytes
  created_at timestamptz not null default now()
);
create index passkey_wraps_user on public.passkey_wraps (user_id);
alter table public.passkey_wraps enable row level security;
revoke all on public.passkey_wraps from anon, authenticated;
grant select on public.passkey_wraps to authenticated;
create policy "owner reads own passkey wraps" on public.passkey_wraps for select to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.passkey_wraps');

create table public.webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  intent text not null check (intent in ('register', 'register_passphrase', 'login', 'add')),
  challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_id uuid references auth.users (id) on delete cascade,      -- 'add': the signed-in account
  new_user_id uuid,                                               -- register*: id the account will get
  handle extensions.citext,                                       -- register*: requested handle
  webauthn_user_id text check (webauthn_user_id ~ '^[A-Za-z0-9_-]{43}$'),  -- register/add: user.id handed out
  ip_tag text check (ip_tag ~ '^[0-9a-f]{32}$'),                  -- HMAC(client IP), rate limits only
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  used_at timestamptz,
  check ((intent = 'add') = (user_id is not null)),
  check ((intent in ('register', 'register_passphrase')) = (new_user_id is not null and handle is not null))
);
create index webauthn_challenges_ip on public.webauthn_challenges (ip_tag, intent, created_at desc);
create index webauthn_challenges_expiry on public.webauthn_challenges (expires_at);
alter table public.webauthn_challenges enable row level security;
revoke all on public.webauthn_challenges from anon, authenticated;

create table public.account_security (
  user_id uuid primary key references auth.users (id) on delete cascade,
  recovery_saved_at timestamptz,
  notice_email text check (char_length(notice_email) between 3 and 254 and notice_email ~ '^[^\s@<>]+@[^\s@<>]+$'),
  notice_email_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((notice_email is null) = (notice_email_verified_at is null))
);
alter table public.account_security enable row level security;
revoke all on public.account_security from anon, authenticated;
grant select on public.account_security to authenticated;
create policy "owner reads own account security" on public.account_security for select to authenticated
  using (user_id = auth.uid());
select kw.require_mfa('public.account_security');

create table public.notice_email_verifications (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),   -- SHA-256 of the link token
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254 and email ~ '^[^\s@<>]+@[^\s@<>]+$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz
);
create index notice_email_verifications_user on public.notice_email_verifications (user_id, created_at desc);
alter table public.notice_email_verifications enable row level security;
revoke all on public.notice_email_verifications from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
-- Can this account still be unlocked without any passkey? A passphrase/password wrap in the key
-- bundle, a recovery phrase the owner confirmed saving, or trusted-friend recovery shares.
create function kw.has_fallback_unlock(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.key_bundles b where b.user_id = u and b.bundle ? 'amkByPassword')
      or exists (select 1 from public.account_security s where s.user_id = u and s.recovery_saved_at is not null)
      or exists (select 1 from public.recovery_shares r where r.owner_id = u)
$$;

create function kw.check_key_bundle(b jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if b is null or jsonb_typeof(b) <> 'object' or (b ->> 'v') is distinct from '1'
     or coalesce(char_length(b ->> 'signPub'), 0) <> 43 or coalesce(char_length(b ->> 'kxPub'), 0) <> 43
     or jsonb_typeof(b -> 'amkByRecovery') is distinct from 'string'
     or jsonb_typeof(b -> 'identityEnc') is distinct from 'string'
     or jsonb_typeof(b -> 'rkCommitment') is distinct from 'string'
     or (b ? 'amkByPassword' and jsonb_typeof(b -> 'amkByPassword') <> 'string') then
    raise exception 'malformed key bundle' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Server-only RPCs (service_role). The route handlers verify WebAuthn / ALTCHA first.
-- ---------------------------------------------------------------------------------------------

-- Atomically consume a challenge: unused, unexpired, matching intent. Returns the row or nothing.
create function public.consume_webauthn_challenge(p_id uuid, p_intent text)
returns setof public.webauthn_challenges
language sql volatile security definer set search_path = '' as $$
  update public.webauthn_challenges c set used_at = now()
   where c.id = p_id and c.intent = p_intent and c.used_at is null and c.expires_at > now()
  returning c.*
$$;

-- How many challenges of this kind did this client ask for recently? (unauthenticated rate limits)
create function public.webauthn_recent_challenges(p_ip_tag text, p_intent text, p_seconds int)
returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.webauthn_challenges c
   where c.ip_tag = p_ip_tag and c.intent = p_intent
     and c.created_at > now() - make_interval(secs => least(greatest(p_seconds, 1), 86400))
$$;

-- The auth user already exists (created by the route with the secret key). Creates in one
-- transaction: key bundle, profile (public keys from the bundle), WebAuthn user handle, and for a
-- passkey account the credential and its AMK wrap. A bundle without a password wrap must come
-- with a passkey wrap, so a new account can always be unlocked.
create function public.create_passkey_account(
  p_user uuid, p_handle text, p_bundle jsonb, p_webauthn_user_id text default null,
  p_credential_id text default null, p_public_key text default null, p_counter bigint default 0,
  p_transports text[] default '{}', p_backed_up boolean default false, p_label text default null,
  p_prf_salt text default null, p_amk_wrap text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare pk uuid;
begin
  perform kw.check_key_bundle(p_bundle);
  if not (p_bundle ? 'amkByPassword') and (p_credential_id is null or p_amk_wrap is null) then
    raise exception 'an account needs a passphrase or a passkey wrap' using errcode = '22023';
  end if;
  if (p_credential_id is null) <> (p_webauthn_user_id is null) then
    raise exception 'passkey and WebAuthn user handle go together' using errcode = '22023';
  end if;
  insert into public.key_bundles (user_id, bundle) values (p_user, p_bundle);
  insert into public.profiles (id, username, sign_pub, kx_pub)
    values (p_user, lower(p_handle), p_bundle ->> 'signPub', p_bundle ->> 'kxPub');
  insert into public.account_security (user_id) values (p_user);
  if p_credential_id is not null then
    insert into public.passkey_users (user_id, webauthn_user_id) values (p_user, p_webauthn_user_id);
    insert into public.passkeys (user_id, credential_id, public_key, counter, transports, backed_up, label)
      values (p_user, p_credential_id, p_public_key, coalesce(p_counter, 0), coalesce(p_transports, '{}'),
              coalesce(p_backed_up, false), coalesce(nullif(trim(p_label), ''), 'Passkey'))
      returning id into pk;
    insert into public.passkey_wraps (passkey_id, user_id, prf_salt, amk_wrap)
      values (pk, p_user, p_prf_salt, p_amk_wrap);
  end if;
  return pk;
end $$;

-- Adds a passkey (+ its AMK wrap) to an existing account. At most 20 per account.
create function public.add_passkey(
  p_user uuid, p_webauthn_user_id text, p_credential_id text, p_public_key text, p_counter bigint,
  p_transports text[], p_backed_up boolean, p_label text, p_prf_salt text, p_amk_wrap text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare pk uuid; existing text;
begin
  select webauthn_user_id into existing from public.passkey_users where user_id = p_user;
  if existing is null then
    insert into public.passkey_users (user_id, webauthn_user_id) values (p_user, p_webauthn_user_id);
  elsif existing <> p_webauthn_user_id then
    raise exception 'WebAuthn user handle mismatch' using errcode = '22023';
  end if;
  if (select count(*) from public.passkeys where user_id = p_user) >= 20 then
    raise exception 'too many passkeys' using errcode = 'P0429';
  end if;
  insert into public.passkeys (user_id, credential_id, public_key, counter, transports, backed_up, label)
    values (p_user, p_credential_id, p_public_key, coalesce(p_counter, 0), coalesce(p_transports, '{}'),
            coalesce(p_backed_up, false), coalesce(nullif(trim(p_label), ''), 'Passkey'))
    returning id into pk;
  insert into public.passkey_wraps (passkey_id, user_id, prf_salt, amk_wrap)
    values (pk, p_user, p_prf_salt, p_amk_wrap);
  insert into public.account_security (user_id) values (p_user) on conflict (user_id) do nothing;
  return pk;
end $$;

-- After a verified assertion: store the new signature counter and the time of use. The counter
-- may only move forward (a clone of the authenticator would replay an old one); 0 means the
-- authenticator doesn't count (most synced passkeys).
create function public.passkey_used(p_credential_id text, p_counter bigint, p_backed_up boolean)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  update public.passkeys p
     set counter = greatest(p.counter, coalesce(p_counter, 0)), backed_up = coalesce(p_backed_up, p.backed_up),
         last_used_at = now()
   where p.credential_id = p_credential_id
     and (coalesce(p_counter, 0) = 0 and p.counter = 0 or coalesce(p_counter, 0) > p.counter)
  returning p.user_id into uid;
  if uid is null then raise exception 'passkey counter did not advance' using errcode = '22023'; end if;
  return uid;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Owner RPCs
-- ---------------------------------------------------------------------------------------------

-- Remove one of my passkeys. Refused when it is the last passkey and the account has no other way
-- to unlock (passphrase/password, a recovery phrase confirmed as saved, trusted friends).
create function public.remove_passkey(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  perform kw.rate_limit('remove_passkey', 30, interval '1 hour');
  if not exists (select 1 from public.passkeys where id = p_id and user_id = me) then
    raise exception 'no such passkey' using errcode = 'P0002';
  end if;
  -- Serialise concurrent removals for this account so two requests can't remove the last two.
  perform 1 from public.passkeys where user_id = me for update;
  if (select count(*) from public.passkeys where user_id = me) <= 1 and not kw.has_fallback_unlock(me) then
    raise exception 'last unlock method' using errcode = 'P0001',
      hint = 'Save your recovery key or add a passphrase before removing your only passkey.';
  end if;
  delete from public.passkeys where id = p_id and user_id = me;   -- cascades to its wrap
end $$;

-- The owner confirmed they saved their (current) recovery phrase (p_saved = true), or is about to
-- replace it (p_saved = false: the client clears the flag before rotating, and sets it again once
-- the new phrase is confirmed), so the flag never vouches for a phrase that no longer works.
create function public.mark_recovery_saved(p_saved boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare at timestamptz := case when p_saved then now() end;
begin
  if auth.uid() is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  insert into public.account_security (user_id, recovery_saved_at) values (auth.uid(), at)
  on conflict (user_id) do update set recovery_saved_at = at, updated_at = now();
end $$;

-- ---------------------------------------------------------------------------------------------
-- Housekeeping: spent/expired challenges and verification links.
-- ---------------------------------------------------------------------------------------------
create function kw.passkey_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.webauthn_challenges where expires_at < now() - interval '1 hour';
  delete from public.notice_email_verifications where expires_at < now() - interval '1 day';
end $$;
select cron.schedule('kithwall-passkey-maintenance', '23 * * * *', $$select kw.passkey_maintenance()$$);

-- ---------------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------------
revoke execute on function kw.has_fallback_unlock(uuid), kw.check_key_bundle(jsonb), kw.passkey_maintenance()
  from public, anon, authenticated;
grant execute on function kw.has_fallback_unlock(uuid) to service_role;
revoke execute on function public.consume_webauthn_challenge(uuid, text), public.webauthn_recent_challenges(text, text, int),
  public.create_passkey_account(uuid, text, jsonb, text, text, text, bigint, text[], boolean, text, text, text),
  public.add_passkey(uuid, text, text, text, bigint, text[], boolean, text, text, text),
  public.passkey_used(text, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.consume_webauthn_challenge(uuid, text), public.webauthn_recent_challenges(text, text, int),
  public.create_passkey_account(uuid, text, jsonb, text, text, text, bigint, text[], boolean, text, text, text),
  public.add_passkey(uuid, text, text, text, bigint, text[], boolean, text, text, text),
  public.passkey_used(text, bigint, boolean)
  to service_role;
revoke execute on function public.remove_passkey(uuid), public.mark_recovery_saved(boolean) from public, anon;
grant execute on function public.remove_passkey(uuid), public.mark_recovery_saved(boolean) to authenticated;

-- Every public table must have RLS enabled (same assertion as 20261019000001_integration.sql).
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
