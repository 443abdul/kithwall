-- Kithwall 2: account recovery that starts from a @handle, so accounts without an email address
-- (passkey and passphrase accounts) can recover too. See docs/v2/01-accounts.md §3 "Recovering an
-- account" and §5 for the threat model.
--  * key_challenges gains purpose 'recover_account': the server issues a nonce for an account; the
--    browser proves it holds the recovery key (typed, or rebuilt from trusted friends' shares) by
--    unlocking the identity key and signing the nonce. Only the server issues these.
--  * notice_emails gains kind 'account_recovered' (a content-free notice after a recovery).
--  * start_handle_recovery(owner, eph_pub): service-role RPC that opens a trusted-friend recovery
--    request for an account without a session. Same waiting period and expiry as before (the
--    recovery_requests trigger sets them), at most 3 requests per account per day, and the trusted
--    friends are told in-app. The owner's signed-in devices show the open request with a cancel button.

alter table public.key_challenges drop constraint if exists key_challenges_purpose_check;
alter table public.key_challenges add constraint key_challenges_purpose_check
  check (purpose in ('delete_account', 'delete_all_posts', 'change_recovery', 'recover_account'));

alter table public.notice_emails drop constraint if exists notice_emails_kind_check;
alter table public.notice_emails add constraint notice_emails_kind_check
  check (kind in ('deletion_scheduled', 'recovery_started', 'account_recovered'));

-- Clients get proof-of-key nonces for themselves; recovery nonces come only from the server.
create or replace function public.create_key_challenge(purpose text) returns table (id uuid, nonce text)
language plpgsql security definer set search_path = '' as $$
begin
  if create_key_challenge.purpose = 'recover_account' then
    raise exception 'recovery challenges are issued by the server' using errcode = '42501';
  end if;
  perform kw.rate_limit('key_challenge', 20, interval '1 hour');
  return query insert into public.key_challenges (user_id, purpose)
    values (auth.uid(), create_key_challenge.purpose)
    returning key_challenges.id, key_challenges.nonce;
end $$;

create function public.start_handle_recovery(p_owner uuid, p_eph_pub text)
returns table (request_id uuid, not_before timestamptz, expires_at timestamptz, threshold int, trustees int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r public.recovery_requests;
  th int;
  n int;
begin
  select min(s.threshold), count(*) into th, n from public.recovery_shares s where s.owner_id = p_owner;
  if n = 0 then
    raise exception 'this account has no trusted friends' using errcode = 'P0002';
  end if;
  if (select count(*) from public.recovery_requests q
       where q.owner_id = p_owner and q.created_at > now() - interval '1 day') >= 3 then
    raise exception 'rate limit exceeded for recovery_request' using errcode = 'P0429';
  end if;
  insert into public.recovery_requests (owner_id, eph_pub) values (p_owner, p_eph_pub) returning * into r;
  insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
    select s.trustee_id, p_owner, 'recovery_request', 'recovery_request', r.id
      from public.recovery_shares s where s.owner_id = p_owner;
  return query select r.id, r.not_before, r.expires_at, th, n::int;
end $$;

revoke execute on function public.start_handle_recovery(uuid, text) from public, anon, authenticated;
grant execute on function public.start_handle_recovery(uuid, text) to service_role;
