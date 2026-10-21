-- Security final review (docs/v2/06-security-review.md §12, NEW-2): the R-W4 fix let a new request at the
-- cap of 10 evict the OLDEST open request, so ten requests from fresh addresses could cancel the owner's own
-- request (or one whose friends were already prompted). There is no cap any more: a request is never refused
-- for being one too many and never cancels anyone else's. What bounds abuse instead:
--   * the proof-of-work on every start (route) and the per-requester limits below (4 a day overall,
--     2 a day per account, one open request per requester per account);
--   * trusted friends are prompted at most once per 12 h per account (kithwall-recovery-notify), only after
--     the waiting period, so many open requests don't mean many prompts;
--   * pending requests expire (expires_at) and are cleaned up by the existing maintenance job.
create or replace function public.start_handle_recovery(p_owner uuid, p_eph_pub text, p_requester text)
returns table (request_id uuid, not_before timestamptz, expires_at timestamptz, threshold int, trustees int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r public.recovery_requests;
  th int;
  n int;
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
  -- One open request per requester per account: the new one supersedes only THEIR OWN earlier one.
  update public.recovery_requests q set status = 'cancelled'
   where q.owner_id = p_owner and q.requester_tag = p_requester and q.status = 'pending';
  insert into public.recovery_requests (owner_id, eph_pub, requester_tag) values (p_owner, p_eph_pub, p_requester)
    returning * into r;
  return query select r.id, r.not_before, r.expires_at, th, n::int;
end $$;
revoke execute on function public.start_handle_recovery(uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_handle_recovery(uuid, text, text) to service_role;
