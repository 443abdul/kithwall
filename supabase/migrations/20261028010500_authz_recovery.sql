-- Security review W4 + L6 (docs/v2/06-security-review.md): account recovery from a @handle could be
-- blocked by anyone (3 junk requests a day used up the owner's own allowance, cancelled ones included,
-- and the recovery-key path's 12 challenges an hour per account), and every junk request immediately
-- pinged the trusted friends "as if the owner asked". The unauthenticated limits lived in per-instance
-- memory.
--
--  1. kw.anon_rate_events + public.anon_rate_hit(): database-backed limits for unauthenticated routes
--     (keyed by a hash the server computes from a daily-rotating IP tag and the scope, never a raw IP).
--  2. start_handle_recovery takes the requester's tag: at most 2 requests per requester per account and
--     4 per requester overall a day, and at most 10 OPEN requests per account (cancelled, completed and
--     expired ones don't count, so junk the owner cancels never blocks them). The routes also require an
--     ALTCHA proof-of-work, so each fake request costs real CPU.
--  3. Trusted friends hear about a request only once its waiting period is over and it is still open
--     (kw.recovery_notify_due, every 10 minutes; at most one prompt per account per 12 hours). During the
--     wait only the owner sees it (in-app on every signed-in device, plus the notice email) and can
--     cancel it. Trustees likewise only see requests whose waiting period has passed.

create table kw.anon_rate_events (
  key text not null check (char_length(key) between 16 and 128),
  at timestamptz not null default now()
);
create index anon_rate_events_lookup on kw.anon_rate_events (key, at desc);
revoke all on kw.anon_rate_events from public, anon, authenticated;

-- Record one hit for `p_key` and say whether it is still within `p_max` per `p_seconds`.
-- Serialised per key, so a burst can't slip past the limit.
create function public.anon_rate_hit(p_key text, p_max int, p_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_key is null or char_length(p_key) < 16 or char_length(p_key) > 128 then
    raise exception 'bad rate key' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kw.anon_rate:' || p_key, 0));
  select count(*) into n from kw.anon_rate_events e
   where e.key = p_key and e.at > now() - make_interval(secs => greatest(p_seconds, 1));
  if n >= p_max then return false; end if;
  insert into kw.anon_rate_events (key) values (p_key);
  return true;
end $$;
revoke execute on function public.anon_rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.anon_rate_hit(text, int, int) to service_role;

insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('kw.anon_rate_events', 'housekeeping', null, 'at', null, '2 days, for rate limits',
   'Counters for sign-in and recovery pages used without an account: a keyed hash of a daily-rotating IP tag and the action, never the address.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('kw.anon_rate_events', 'key', 'hashed', 'keyed hash of the action and a daily-rotating IP tag'),
  ('kw.anon_rate_events', 'at', 'time', null);

-- ---------------------------------------------------------------------------------------
-- Recovery requests: who asked (hashed tag) and when friends were told.
-- ---------------------------------------------------------------------------------------
alter table public.recovery_requests add column requester_tag text check (requester_tag is null or char_length(requester_tag) between 16 and 64);
alter table public.recovery_requests add column friends_notified_at timestamptz;
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.recovery_requests', 'requester_tag', 'hashed', 'daily-rotating keyed hash of the requesting IP, for spam limits'),
  ('public.recovery_requests', 'friends_notified_at', 'time', null);

-- Only the server sets these.
create or replace function kw.recovery_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('recovery_request', 3, interval '1 day');
    new.created_at := now();
    -- Waiting period comes from settings (default 24 h); never shorter than server policy.
    new.not_before := now() + coalesce((kw.setting('recovery_wait_hours')::text)::int, 24) * interval '1 hour';
    new.expires_at := now() + interval '72 hours';
    new.status := 'pending';
    new.friends_notified_at := null;
    if auth.uid() is not null then new.requester_tag := null; end if;
    return new;
  end if;
  if new.not_before <> old.not_before or new.expires_at <> old.expires_at or new.eph_pub <> old.eph_pub
     or new.owner_id <> old.owner_id or new.requester_tag is distinct from old.requester_tag
     or (auth.uid() is not null and new.friends_notified_at is distinct from old.friends_notified_at) then
    raise exception 'recovery request is immutable';
  end if;
  if old.status <> 'pending' then raise exception 'recovery request is closed'; end if;
  return new;
end $$;

-- Trustees see a request only after its waiting period (the owner sees theirs at once).
drop policy "owner and trustees see requests" on public.recovery_requests;
create policy "owner sees requests; trustees once the wait is over" on public.recovery_requests
  for select to authenticated using (
    owner_id = (select auth.uid())
    or (now() >= not_before and exists (select 1 from public.recovery_shares s
                                         where s.owner_id = recovery_requests.owner_id and s.trustee_id = (select auth.uid()))));

drop function public.start_handle_recovery(uuid, text);
create function public.start_handle_recovery(p_owner uuid, p_eph_pub text, p_requester text)
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
          where q.owner_id = p_owner and q.requester_tag = p_requester and q.created_at > now() - interval '1 day') >= 2
     or (select count(*) from public.recovery_requests q
          where q.owner_id = p_owner and q.status = 'pending' and q.expires_at > now()) >= 10 then
    raise exception 'rate limit exceeded for recovery_request' using errcode = 'P0429';
  end if;
  insert into public.recovery_requests (owner_id, eph_pub, requester_tag) values (p_owner, p_eph_pub, p_requester)
    returning * into r;
  -- Friends are told later, by kw.recovery_notify_due(), once the waiting period is over.
  return query select r.id, r.not_before, r.expires_at, th, n::int;
end $$;
revoke execute on function public.start_handle_recovery(uuid, text, text) from public, anon, authenticated;
grant execute on function public.start_handle_recovery(uuid, text, text) to service_role;

-- Every 10 minutes: tell the trusted friends about open requests whose waiting period is over
-- (once per account per 12 hours, however many requests are open).
create function kw.recovery_notify_due() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct on (q.owner_id) q.id, q.owner_id from public.recovery_requests q
     where q.status = 'pending' and q.friends_notified_at is null and q.not_before <= now() and q.expires_at > now()
     order by q.owner_id, q.created_at
  loop
    if not exists (select 1 from public.recovery_requests x
                    where x.owner_id = r.owner_id and x.friends_notified_at > now() - interval '12 hours') then
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        select s.trustee_id, r.owner_id, 'recovery_request', 'recovery_request', r.id
          from public.recovery_shares s where s.owner_id = r.owner_id;
    end if;
    update public.recovery_requests set friends_notified_at = now()
     where owner_id = r.owner_id and status = 'pending' and friends_notified_at is null and not_before <= now();
  end loop;
  delete from kw.anon_rate_events where at < now() - interval '2 days';
end $$;
revoke execute on function kw.recovery_notify_due() from public, anon, authenticated;
select cron.schedule('kithwall-recovery-notify', '*/10 * * * *', $$select kw.recovery_notify_due()$$);
