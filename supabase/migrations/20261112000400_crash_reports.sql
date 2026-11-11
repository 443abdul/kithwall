-- Crash reports (opt-in; docs/v2/03-transparency.md §6). Off for everyone until they turn "Send crash
-- reports" on in Settings → Your data. A report says what broke (error class, a scrubbed message and stack,
-- the route pattern) and on what kind of device (app build, platform, OS and browser major version,
-- interface language). It never says who: there is no account, session, device or IP column here, the
-- only id is random per report, and the time is kept to the hour. The device scrubs the text and the server
-- scrubs it again before calling crash_report_add() (apps/web/src/lib/crash/scrub.ts).
--
--  1. public.crash_reports: written only by the server (service role) through crash_report_add();
--     readable only by admins (RLS), never by moderators, members or the public.
--  2. crash_report_groups(): what Admin shows: one row per fingerprint (same bug) with a count, first and
--     last hour seen, the builds it happened in and the newest report as a sample.
--  3. prune_crash_reports(): deletes reports older than 30 days; called by the daily
--     /api/cron/ephemeral job (Vercel Cron), so no report outlives a month.

create table public.crash_reports (
  id uuid primary key,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{32}$'),
  kind text not null check (kind in ('error', 'rejection', 'react', 'native')),
  platform text not null check (platform in ('web', 'pwa', 'android', 'ios')),
  app_web text not null default '' check (app_web ~ '^[A-Za-z0-9._+-]{0,40}$'),
  app_version text not null default '' check (app_version ~ '^[A-Za-z0-9._+-]{0,40}$'),
  app_build text not null default '' check (app_build ~ '^[A-Za-z0-9._+-]{0,40}$'),
  os text not null check (os ~ '^[A-Za-z][A-Za-z ]{0,23}( [0-9]{1,3})?$'),
  browser text not null check (browser ~ '^[A-Za-z][A-Za-z ]{0,23}( [0-9]{1,3})?$'),
  route text not null check (char_length(route) between 1 and 80 and route ~ '^/[A-Za-z0-9\[\]./_-]*$'),
  locale text not null check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  name text not null check (char_length(name) between 1 and 80),
  message text not null default '' check (char_length(message) <= 300),
  stack text not null default '' check (char_length(stack) <= 4000),
  component_stack text not null default '' check (char_length(component_stack) <= 1500),
  -- To the hour: enough to see when a bug started, too coarse to line a report up with a request log.
  received_at timestamptz not null default date_trunc('hour', now())
);
create index crash_reports_group on public.crash_reports (fingerprint, received_at desc);
create index crash_reports_age on public.crash_reports (received_at);

alter table public.crash_reports enable row level security;
revoke all on public.crash_reports from public, anon, authenticated;
grant select on public.crash_reports to authenticated;
create policy "admins read crash reports" on public.crash_reports
  for select to authenticated using ((select kw.is_admin()));
select kw.require_mfa('public.crash_reports');

-- Store one report (the API route, service role only). A repeated id (a retried upload) is kept once.
-- At most p_daily_max reports are kept per day in total, so a flood can't fill the table; returns
-- whether this one was stored.
create function public.crash_report_add(
  p_id uuid, p_fingerprint text, p_kind text, p_platform text, p_app_web text, p_app_version text, p_app_build text,
  p_os text, p_browser text, p_route text, p_locale text, p_name text, p_message text, p_stack text,
  p_component_stack text, p_daily_max int default 2000
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended('kw.crash_reports', 0));
  select count(*) into n from public.crash_reports c where c.received_at >= date_trunc('day', now());
  if n >= greatest(p_daily_max, 1) then return false; end if;
  insert into public.crash_reports (id, fingerprint, kind, platform, app_web, app_version, app_build, os, browser,
                                    route, locale, name, message, stack, component_stack)
  values (p_id, p_fingerprint, p_kind, p_platform, p_app_web, p_app_version, p_app_build, p_os, p_browser,
          p_route, p_locale, p_name, p_message, p_stack, p_component_stack)
  on conflict (id) do nothing;
  return true;
end $$;
revoke execute on function public.crash_report_add(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, int)
  from public, anon, authenticated;
grant execute on function public.crash_report_add(uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, int)
  to service_role;

-- One row per bug for Admin (admins only; the function checks, since it reads past RLS).
create function public.crash_report_groups(p_limit int default 100)
returns table (fingerprint text, reports bigint, first_seen timestamptz, last_seen timestamptz, versions text[], platforms text[], sample jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not kw.is_admin() or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  return query
    select g.fingerprint, g.reports, g.first_seen, g.last_seen, g.versions, g.platforms,
           (select to_jsonb(s) - 'fingerprint' from public.crash_reports s
             where s.fingerprint = g.fingerprint order by s.received_at desc, s.id limit 1)
      from (select c.fingerprint, count(*) as reports, min(c.received_at) as first_seen, max(c.received_at) as last_seen,
                   coalesce(array_agg(distinct c.ver order by c.ver) filter (where c.ver <> ''), '{}') as versions,
                   array_agg(distinct c.platform order by c.platform) as platforms
              from (select r.fingerprint, r.received_at, r.platform,
                           concat_ws(' ', nullif(r.app_version, ''), nullif(r.app_web, '')) as ver
                      from public.crash_reports r) c
             group by c.fingerprint) g
     order by g.last_seen desc, g.reports desc
     limit least(greatest(p_limit, 1), 500);
end $$;
revoke execute on function public.crash_report_groups(int) from public, anon;
grant execute on function public.crash_report_groups(int) to authenticated;

-- Reports older than 30 days are deleted (daily, from /api/cron/ephemeral). Returns how many went.
create function public.prune_crash_reports() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.crash_reports where received_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.prune_crash_reports() from public, anon, authenticated;
grant execute on function public.prune_crash_reports() to service_role;

-- Data map (20261024000900_transparency.sql): no owner predicate, because no row is about a person.
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.crash_reports', 'system', null, 'received_at', null, '30 days',
   'Crash reports from people who turned them on: what broke and on what kind of device. No account, session, device id or IP address; the text is scrubbed on the device and again on the server.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.crash_reports', 'id', 'id', 'random per report, made on the device; not linked to anything'),
  ('public.crash_reports', 'fingerprint', 'hashed', 'hash of the error class and top stack frames, to group reports of the same bug'),
  ('public.crash_reports', 'kind', 'plaintext', 'where it was caught: page error, promise rejection, screen crash or the Android app itself'),
  ('public.crash_reports', 'platform', 'plaintext', 'website, installed web app, Android app or iOS app'),
  ('public.crash_reports', 'app_web', 'plaintext', 'website build (commit)'),
  ('public.crash_reports', 'app_version', 'plaintext', 'app version name'),
  ('public.crash_reports', 'app_build', 'plaintext', 'app build number'),
  ('public.crash_reports', 'os', 'plaintext', 'operating system and major version'),
  ('public.crash_reports', 'browser', 'plaintext', 'browser or WebView and major version'),
  ('public.crash_reports', 'route', 'plaintext', 'route pattern such as /messages/[id], never the address'),
  ('public.crash_reports', 'locale', 'plaintext', 'interface language'),
  ('public.crash_reports', 'name', 'plaintext', 'error class'),
  ('public.crash_reports', 'message', 'plaintext', 'scrubbed error message (up to 300 characters)'),
  ('public.crash_reports', 'stack', 'plaintext', 'scrubbed stack frames of the app''s own code'),
  ('public.crash_reports', 'component_stack', 'plaintext', 'scrubbed React component names'),
  ('public.crash_reports', 'received_at', 'time', 'kept to the hour');
