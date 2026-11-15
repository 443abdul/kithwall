-- Kithwall 2: two retention periods the data map promised but nothing enforced.
--
-- "What Kithwall knows" (kw.data_map_tables) and the privacy policy say notifications are kept 90 days and
-- moderation decisions 1 year. Until now no job deleted either, so a row lived as long as its account. The
-- hourly maintenance job now removes them.
--
-- A moderation decision that is still in force (a suspension that has not run out) is kept until it ends,
-- so the person it concerns can still see why. A permanent ban is recorded on the profile itself.

create or replace function kw.transparency_maintenance() returns void
language sql security definer set search_path = '' as $$
  delete from kw.rate_events where at < now() - interval '7 days';
  delete from public.notifications where created_at < now() - interval '90 days';
  delete from public.moderation_actions
   where created_at < now() - interval '1 year' and (expires_at is null or expires_at < now());
$$;
revoke execute on function kw.transparency_maintenance() from public, anon, authenticated;

create index if not exists notifications_created_at on public.notifications (created_at);
