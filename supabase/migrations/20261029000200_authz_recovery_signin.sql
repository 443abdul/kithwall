-- Security re-review (docs/v2/06-security-review.md §10.2): R-W4 and R-W3.
--
-- R-W4 trusted-friend recovery could be locked: start_handle_recovery refused new requests once an account
-- had 10 open ones, and five IPv4 addresses (or one IPv6 /64, whose addresses all got different tags) kept
-- it there indefinitely, so an owner who had lost every device could never start a recovery. Now:
--   * the requester tag is computed from the IPv6 /64 (IPv4: the address), lib/auth/passkey-server.ts;
--   * a requester has at most ONE open request per account: a new one from the same tag supersedes it;
--   * at the cap of 10 open requests a new request is never refused: it supersedes the OLDEST open request
--     (status 'cancelled'). Filling the cap now needs 10 distinct tags, and even then the newest request
--     (the owner's, when they try) always gets in;
--   * the per-requester daily limits (2 per account, 4 overall) and the proof-of-work stay.
--   The recovery-key path no longer has an account-wide limit that strangers can use up (the route keeps
--   per-client limits and a proof-of-work; a nonce is useless without the recovery key).
--
-- R-W3 password sign-in timing told passphrase accounts apart: GoTrue ran bcrypt for them and answered at
-- once for passkey-only accounts and decoys. Now:
--   * public.passphrase_password_ok() checks the password in the database with exactly one bcrypt for every
--     input (a throwaway hash when the address is unknown or has no password), for
--     /api/auth/passkey/passphrase/signin, which also limits attempts per handle and mints the session;
--   * passkey-only synthetic accounts get a random, never-used password, so even calling GoTrue's password
--     grant directly costs one bcrypt for every synthetic account, whatever its type.

-- ---------------------------------------------------------------------------------------
-- R-W4
-- ---------------------------------------------------------------------------------------
create or replace function public.start_handle_recovery(p_owner uuid, p_eph_pub text, p_requester text)
returns table (request_id uuid, not_before timestamptz, expires_at timestamptz, threshold int, trustees int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r public.recovery_requests;
  th int;
  n int;
  open_n int;
begin
  if p_requester is null or char_length(p_requester) not between 16 and 64 then
    raise exception 'requester tag required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kw.recovery:' || p_owner::text, 0));
  select min(s.threshold), count(*) into th, n from public.recovery_shares s where s.owner_id = p_owner;
  if n = 0 then
    raise exception 'this account has no trusted friends' using errcode = 'P0002';
  end if;
  if (select count(*) from public.recovery_requests q
       where q.requester_tag = p_requester and q.created_at > now() - interval '1 day') >= 4
     or (select count(*) from public.recovery_requests q
          where q.owner_id = p_owner and q.requester_tag = p_requester and q.created_at > now() - interval '1 day') >= 2 then
    raise exception 'rate limit exceeded for recovery_request' using errcode = 'P0429';
  end if;
  -- One open request per requester per account: the new one supersedes theirs.
  update public.recovery_requests q set status = 'cancelled'
   where q.owner_id = p_owner and q.requester_tag = p_requester and q.status = 'pending';
  -- At the cap, the oldest open request makes room (never a refusal, so nobody can hold the owner out).
  select count(*) into open_n from public.recovery_requests q
   where q.owner_id = p_owner and q.status = 'pending' and q.expires_at > now();
  if open_n >= 10 then
    update public.recovery_requests q set status = 'cancelled'
     where q.id in (select x.id from public.recovery_requests x
                     where x.owner_id = p_owner and x.status = 'pending' and x.expires_at > now()
                     order by x.created_at, x.id limit open_n - 9);
  end if;
  insert into public.recovery_requests (owner_id, eph_pub, requester_tag) values (p_owner, p_eph_pub, p_requester)
    returning * into r;
  return query select r.id, r.not_before, r.expires_at, th, n::int;
end $$;
revoke execute on function public.start_handle_recovery(uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_handle_recovery(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------
-- R-W3
-- ---------------------------------------------------------------------------------------
-- The user id when `p_auth_key` is the password of the (synthetic) address `p_email`, else null. Always
-- exactly one bcrypt (cost 10, like GoTrue's), whether or not the address exists or has a password.
create function public.passphrase_password_ok(p_email text, p_auth_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare u record; h text; ok boolean;
begin
  if p_email is null or p_auth_key is null or char_length(p_auth_key) > 200
     or p_email !~ '^u[0-9a-f]{32}@id\.kithwall\.invalid$' then
    perform extensions.crypt(coalesce(p_auth_key, ''), extensions.gen_salt('bf', 10));
    return null;
  end if;
  select x.id, x.encrypted_password, x.banned_until, x.deleted_at into u
    from auth.users x where x.email = p_email limit 1;
  h := case when found and u.encrypted_password ~ '^\$2[aby]\$[0-9]{2}\$' then u.encrypted_password end;
  if h is null then
    perform extensions.crypt(p_auth_key, extensions.gen_salt('bf', 10));
    return null;
  end if;
  ok := extensions.crypt(p_auth_key, h) = h;
  if not ok or u.deleted_at is not null or (u.banned_until is not null and u.banned_until > now()) then return null; end if;
  return u.id;
end $$;
revoke execute on function public.passphrase_password_ok(text, text) from public, anon, authenticated;
grant execute on function public.passphrase_password_ok(text, text) to service_role;

-- Passkey-only synthetic accounts: a random password nobody knows, so a direct password grant against any
-- synthetic account runs bcrypt (lib/auth/passkey-server.ts gives new passkey accounts one too).
update auth.users
   set encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf', 10))
 where email like 'u%@id.kithwall.invalid' and coalesce(encrypted_password, '') = '';
