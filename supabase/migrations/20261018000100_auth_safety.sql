-- Auth, account & safety (engineer A).
--  * app setting recovery_wait_hours + validation of operator settings
--  * ALTCHA replay protection (used by the before-user-created auth hook route)
--  * delayed account deletion for people who lost every key (72 h, cancellable)
--  * MFA enforcement in the database: once a user has a verified TOTP factor, every table
--    (and the media bucket) requires an aal2 session (restrictive RLS policy)
--  * session list / revoke for Settings → Security
--  * report evidence snapshot (row metadata needed to verify a disclosed key)
--  * staff may remove reported messages
--  * housekeeping job (pg_cron)

-- ---------------------------------------------------------------------------
-- Operator settings
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values ('recovery_wait_hours', '24'::jsonb)
on conflict (key) do nothing;

create function kw.app_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.key <> old.key then raise exception 'setting key is immutable'; end if;
  if new.key in ('public_audience_enabled', 'signups_enabled') and jsonb_typeof(new.value) <> 'boolean' then
    raise exception '% must be true or false', new.key using errcode = '22023';
  end if;
  if new.key = 'recovery_wait_hours' and not (
       jsonb_typeof(new.value) = 'number'
       and (new.value #>> '{}')::numeric = trunc((new.value #>> '{}')::numeric)
       and (new.value #>> '{}')::numeric between 0 and 168) then
    raise exception 'recovery_wait_hours must be a whole number of hours between 0 and 168' using errcode = '22023';
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;
create trigger app_settings_guard before update on public.app_settings
  for each row execute function kw.app_settings_guard();

-- ---------------------------------------------------------------------------
-- ALTCHA replay protection. Only the server (secret key) touches this table.
-- ---------------------------------------------------------------------------
create table public.altcha_spent (
  signature text primary key check (char_length(signature) between 16 and 256),
  spent_at timestamptz not null default now()
);
alter table public.altcha_spent enable row level security;
revoke all on public.altcha_spent from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Content-free notice emails already sent (dedupe; server only).
-- ---------------------------------------------------------------------------
create table public.notice_emails (
  kind text not null check (kind in ('deletion_scheduled', 'recovery_started')),
  ref_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (kind, ref_id)
);
alter table public.notice_emails enable row level security;
revoke all on public.notice_emails from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Delayed account deletion ("I've lost everything").
-- Someone without any key cannot prove ownership (spec §3.9), so instead of proof-of-key the
-- account is deleted only after a 72-hour public waiting period. Any normal login (which proves
-- the password) cancels it, and every signed-in session shows a notice.
-- ---------------------------------------------------------------------------
create table public.account_deletion_requests (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  execute_after timestamptz not null
);
alter table public.account_deletion_requests enable row level security;
create policy "owner sees own deletion request" on public.account_deletion_requests
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies: the RPCs below are the only writers.

create function public.request_account_deletion() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); at timestamptz;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform kw.rate_limit('account_deletion_request', 5, interval '1 day');
  insert into public.account_deletion_requests (user_id, execute_after)
    values (me, now() + interval '72 hours')
    on conflict (user_id) do nothing;
  select execute_after into at from public.account_deletion_requests where user_id = me;
  return at;
end $$;

create function public.cancel_account_deletion() returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.account_deletion_requests where user_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Server-only (secret key): requests whose waiting period is over.
create function public.due_account_deletions(max_rows int default 50) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select user_id from public.account_deletion_requests
   where execute_after <= now() order by execute_after limit least(greatest(max_rows, 1), 500)
$$;

-- ---------------------------------------------------------------------------
-- MFA enforcement. Supabase marks sessions aal1 (password) or aal2 (password + TOTP).
-- When a user has a verified factor, everything requires aal2, so a stolen password or an
-- email-reset session alone can't read even ciphertext or the wrapped key bundle.
-- ---------------------------------------------------------------------------
create function kw.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or auth.uid() is null
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
$$;

-- Adds the restrictive policy to one table. Later migrations should call this for every new
-- user-data table:  select kw.require_mfa('public.my_table');
create function kw.require_mfa(tbl regclass) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from pg_policies p
              where format('%I.%I', p.schemaname, p.tablename)::regclass = tbl
                and p.policyname = 'require mfa when enrolled') then
    return;
  end if;
  execute format(
    'create policy "require mfa when enrolled" on %s as restrictive for all to authenticated '
    'using ((select kw.mfa_ok())) with check ((select kw.mfa_ok()))', tbl);
end $$;
revoke execute on function kw.require_mfa(regclass) from public, anon, authenticated;

do $$
declare t record;
begin
  for t in
    select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and c.relname not in ('app_settings', 'altcha_spent', 'notice_emails')
  loop
    perform kw.require_mfa(t.rel);
  end loop;
end $$;

create policy "require mfa when enrolled (media)" on storage.objects as restrictive
  for all to authenticated using (bucket_id <> 'media' or (select kw.mfa_ok()))
  with check (bucket_id <> 'media' or (select kw.mfa_ok()));

-- ---------------------------------------------------------------------------
-- Sessions (Settings → Security). IP addresses are not exposed.
-- ---------------------------------------------------------------------------
create function public.my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, aal text, user_agent text, is_current boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_at, coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at), s.aal::text,
         left(s.user_agent, 300), s.id::text = (auth.jwt() ->> 'session_id')
    from auth.sessions s
   where s.user_id = auth.uid() and (s.not_after is null or s.not_after > now()) and kw.mfa_ok()
   order by 3 desc
$$;

create function public.revoke_my_session(session uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  delete from auth.sessions where id = session and user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------------
-- Reports: snapshot the row metadata needed to rebuild the envelope header, so moderators
-- can check the disclosed key opens the stored ciphertext even if the item changes later.
-- (Runs after kw.reports_guard, which fills stored_envelope; trigger names fire alphabetically.)
-- ---------------------------------------------------------------------------
alter table public.reports add column stored_meta jsonb;

create function kw.reports_snapshot_meta() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.stored_meta is distinct from old.stored_meta then raise exception 'report evidence is immutable'; end if;
    return new;
  end if;
  new.stored_meta := null;
  if new.target_kind = 'post' then
    select jsonb_build_object('id', p.id, 'author_id', p.author_id, 'wall_owner_id', p.wall_owner_id,
             'group_id', p.group_id, 'event_id', p.event_id, 'page_id', p.page_id, 'kind', p.kind,
             'is_public', p.is_public, 'audience_id', p.audience_id, 'epoch', p.epoch)
      into new.stored_meta from public.posts p where p.id = new.target_id;
  elsif new.target_kind = 'comment' then
    select jsonb_build_object('id', c.id, 'author_id', c.author_id, 'post_id', c.post_id, 'photo_id', c.photo_id)
      into new.stored_meta from public.comments c where c.id = new.target_id;
  elsif new.target_kind = 'photo' then
    select jsonb_build_object('id', p.id, 'album_id', p.album_id, 'owner_id', p.owner_id,
             'is_public', p.is_public, 'audience_id', p.audience_id, 'epoch', p.epoch)
      into new.stored_meta from public.photos p where p.id = new.target_id;
  elsif new.target_kind = 'message' then
    select jsonb_build_object('id', m.id, 'conversation_id', m.conversation_id, 'sender_id', m.sender_id,
             'epoch', m.epoch, 'audience_id', c.audience_id)
      into new.stored_meta from public.messages m join public.conversations c on c.id = m.conversation_id
     where m.id = new.target_id;
  end if;
  return new;
end $$;
create trigger reports_snapshot_meta before insert or update on public.reports
  for each row execute function kw.reports_snapshot_meta();

-- Staff never get read access to content rows (moderators verify the report snapshot instead).
-- Removing a reported item goes through this audited RPC, which records the decision.
create function public.mod_remove_content(report uuid, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not kw.is_staff() or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  if note is null or char_length(btrim(note)) = 0 then raise exception 'a decision note is required' using errcode = '22023'; end if;
  select * into r from public.reports where id = report;
  if not found then raise exception 'no such report' using errcode = 'P0002'; end if;
  if r.target_kind = 'post' then delete from public.posts where id = r.target_id;
  elsif r.target_kind = 'comment' then delete from public.comments where id = r.target_id;
  elsif r.target_kind = 'photo' then delete from public.photos where id = r.target_id;
  elsif r.target_kind = 'message' then delete from public.messages where id = r.target_id;
  else raise exception 'this kind of report is handled with a warning, suspension or ban' using errcode = '22023';
  end if;
  if r.target_owner_id is not null then
    insert into public.moderation_actions (moderator_id, target_user_id, report_id, action, reason)
      values (auth.uid(), r.target_owner_id, r.id, 'remove_content', left(note, 2000));
  end if;
  update public.reports set status = 'actioned', decision_note = left(note, 4000) where id = r.id;
end $$;

-- A moderator's own account can be deleted; their past actions stay (moderator unknown).
alter table public.moderation_actions alter column moderator_id drop not null;

-- ---------------------------------------------------------------------------
-- Housekeeping (hourly): expired challenges, spent ALTCHA signatures, closed recovery
-- requests (spec §7.1: 7 days after they close) and a database-side backstop for
-- scheduled deletions the web cron did not finish within a day.
-- ---------------------------------------------------------------------------
create function kw.auth_maintenance() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.key_challenges where created_at < now() - interval '1 day';
  delete from public.altcha_spent where spent_at < now() - interval '1 day';
  delete from public.recovery_requests where expires_at < now() - interval '7 days';
  delete from public.reports where status <> 'open' and resolved_at < now() - interval '1 year';
  -- Backstop: deleting the auth user cascades every row (crypto-shredding: the keys are gone).
  -- The web cron normally does this first and also removes the storage folder.
  delete from auth.users u using public.account_deletion_requests r
   where r.user_id = u.id and r.execute_after < now() - interval '24 hours';
end $$;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
select cron.schedule('kithwall-auth-maintenance', '17 * * * *', $$select kw.auth_maintenance()$$);

-- ---------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema kw from public, anon;
grant execute on function kw.mfa_ok() to authenticated, service_role;
revoke execute on function public.mod_remove_content(uuid, text) from public, anon;
grant execute on function public.mod_remove_content(uuid, text) to authenticated;
revoke execute on function kw.auth_maintenance() from authenticated;
revoke execute on function kw.require_mfa(regclass) from authenticated;
revoke execute on function public.request_account_deletion(), public.cancel_account_deletion(),
  public.my_sessions(), public.revoke_my_session(uuid), public.due_account_deletions(int) from public, anon;
grant execute on function public.request_account_deletion(), public.cancel_account_deletion(),
  public.my_sessions(), public.revoke_my_session(uuid) to authenticated;
revoke execute on function public.due_account_deletions(int) from authenticated;
grant execute on function public.due_account_deletions(int) to service_role;
