-- Safety centre: safety check-ins (docs/v2/03-safety.md §5).
--
-- "If I don't check in by <time>, alert these people." The person writes the alert now; their device
-- seals it to each chosen contact as an ordinary end-to-end encrypted message in their one-to-one
-- chat (same envelope, key and signature as any other message) and stores the sealed messages here.
-- Until the deadline the alerts are visible to their owner only: recipients can't read the rows, and
-- nothing about them appears in their chats. Checking in before the deadline deletes them (or, for a
-- daily check-in, moves the deadline to the next day). At the deadline a pg_cron job copies each sealed
-- alert into public.messages; the existing AFTER INSERT trigger (20261020000100_push.sql) then sends
-- the normal "new message" push, and the recipient's app decrypts it like any other message.
--
-- The server learns: that a check-in exists, its deadline, whether it repeats daily, and which
-- one-to-one chats would be alerted (i.e. who). It never sees the alert text or the location.

create table public.safety_checkins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  due_at timestamptz not null,
  repeat_daily boolean not null default false,
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index safety_checkins_due on public.safety_checkins (due_at) where released_at is null;
create index safety_checkins_owner on public.safety_checkins (owner_id);
alter table public.safety_checkins enable row level security;

create policy "owner reads own check-ins" on public.safety_checkins for select to authenticated
  using (owner_id = auth.uid());
-- Cancelling = deleting (the sealed alerts go with it, on delete cascade).
create policy "owner cancels own check-ins" on public.safety_checkins for delete to authenticated
  using (owner_id = auth.uid() and released_at is null);
select kw.require_mfa('public.safety_checkins');

-- The deferred, sealed alert messages. `id` becomes the message id on release (it is part of the
-- signed envelope header, so it was fixed when the message was sealed).
create table public.safety_checkin_alerts (
  id uuid primary key,
  checkin_id uuid not null references public.safety_checkins (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  epoch int not null check (epoch >= 1),
  envelope jsonb not null check (octet_length(envelope::text) < 65536),
  created_at timestamptz not null default now()
);
create index safety_checkin_alerts_checkin on public.safety_checkin_alerts (checkin_id);
alter table public.safety_checkin_alerts enable row level security;

-- Only the owner can see their pending alerts. There is deliberately no policy that lets a
-- recipient (or anyone else) see them; writes go through the RPCs below.
create policy "owner reads own pending alerts" on public.safety_checkin_alerts for select to authenticated
  using (owner_id = auth.uid());
select kw.require_mfa('public.safety_checkin_alerts');

revoke all on table public.safety_checkins, public.safety_checkin_alerts from anon;
revoke insert, update on table public.safety_checkins, public.safety_checkin_alerts from authenticated;
revoke delete on table public.safety_checkin_alerts from authenticated;

-- ---------------------------------------------------------------------------------------------
-- Owner RPCs
-- ---------------------------------------------------------------------------------------------

-- Arm a check-in with 1–10 sealed alerts: [{id, conversation_id, epoch, envelope}, …]. Each alert must
-- go to a one-to-one chat the caller is in and that isn't blocked. At most 5 armed check-ins.
create function public.create_safety_checkin(p_due timestamptz, p_repeat boolean, p_alerts jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  a jsonb;
  conv record;
  aid uuid;
  ep int;
begin
  if uid is null or not kw.mfa_ok() or not kw.is_active(uid) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_due is null or p_due < now() + interval '5 minutes' or p_due > now() + interval '31 days' then
    raise exception 'the deadline must be between 5 minutes and 31 days from now' using errcode = '22023';
  end if;
  if p_alerts is null or jsonb_typeof(p_alerts) <> 'array' or jsonb_array_length(p_alerts) not between 1 and 10 then
    raise exception 'choose between 1 and 10 people to alert' using errcode = '22023';
  end if;
  if (select count(*) from public.safety_checkins s where s.owner_id = uid and s.released_at is null) >= 5 then
    raise exception 'too many active check-ins' using errcode = 'P0429';
  end if;
  perform kw.rate_limit('safety_checkin', 50, interval '1 day');

  insert into public.safety_checkins (owner_id, due_at, repeat_daily)
    values (uid, p_due, coalesce(p_repeat, false)) returning id into cid;

  for a in select value from jsonb_array_elements(p_alerts) loop
    begin
      aid := (a ->> 'id')::uuid;
      ep := (a ->> 'epoch')::int;
    exception when others then
      raise exception 'malformed alert' using errcode = '22023';
    end;
    select c.id, c.audience_id, c.dm_key into conv
      from public.conversations c where c.id = (a ->> 'conversation_id')::uuid;
    if not found or conv.dm_key is null or not (uid::text = any (string_to_array(conv.dm_key, ':')))
       or not kw.is_member(conv.audience_id) then
      raise exception 'alerts can only go to your one-to-one chats' using errcode = '42501';
    end if;
    if kw.dm_blocked(conv.id) then
      raise exception 'this chat is blocked' using errcode = '42501';
    end if;
    if ep is null or ep < 1 or ep > (select x.current_epoch from public.audiences x where x.id = conv.audience_id) then
      raise exception 'malformed alert' using errcode = '22023';
    end if;
    if jsonb_typeof(a -> 'envelope') <> 'object' then
      raise exception 'malformed alert' using errcode = '22023';
    end if;
    if exists (select 1 from public.messages m where m.id = aid) then
      raise exception 'malformed alert' using errcode = '22023';
    end if;
    insert into public.safety_checkin_alerts (id, checkin_id, owner_id, conversation_id, epoch, envelope)
      values (aid, cid, uid, conv.id, ep, a -> 'envelope');
  end loop;
  return cid;
end $$;

-- "I'm OK": a one-off check-in is deleted with its alerts; a daily one moves to the next day.
-- Returns the next deadline, or null when the check-in is gone.
create function public.safety_check_in(p_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  nxt timestamptz;
begin
  if auth.uid() is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into r from public.safety_checkins s
   where s.id = p_id and s.owner_id = auth.uid() and s.released_at is null for update;
  if not found then raise exception 'no such check-in' using errcode = 'P0002'; end if;
  if not r.repeat_daily then
    delete from public.safety_checkins where id = r.id;
    return null;
  end if;
  nxt := r.due_at + interval '1 day';
  while nxt <= now() + interval '5 minutes' loop nxt := nxt + interval '1 day'; end loop;
  update public.safety_checkins set due_at = nxt where id = r.id;
  return nxt;
end $$;

-- Release one check-in now: copy its sealed alerts into public.messages (each insert fires the
-- normal message push), then mark it released. Skips chats that no longer exist or are blocked.
create function kw.release_checkin(p_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  a record;
  n int := 0;
begin
  select * into r from public.safety_checkins s where s.id = p_id and s.released_at is null for update skip locked;
  if not found then return 0; end if;
  for a in select * from public.safety_checkin_alerts x where x.checkin_id = r.id order by x.created_at loop
    if exists (select 1 from public.conversations c where c.id = a.conversation_id)
       and not kw.dm_blocked(a.conversation_id)
       and not exists (select 1 from public.messages m where m.id = a.id) then
      insert into public.messages (id, conversation_id, sender_id, epoch, envelope)
        values (a.id, a.conversation_id, a.owner_id, a.epoch, a.envelope);
      n := n + 1;
    end if;
  end loop;
  delete from public.safety_checkin_alerts where checkin_id = r.id;
  update public.safety_checkins set released_at = now() where id = r.id;
  return n;
end $$;

-- "Alert them now" (the owner's own panic button): releases the check-in immediately.
create function public.safety_checkin_alert_now(p_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  if not exists (select 1 from public.safety_checkins s where s.id = p_id and s.owner_id = auth.uid() and s.released_at is null) then
    raise exception 'no such check-in' using errcode = 'P0002';
  end if;
  return kw.release_checkin(p_id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- pg_cron: every minute, release what is due; a week later, forget released check-ins.
-- ---------------------------------------------------------------------------------------------
create function kw.release_due_checkins() returns int
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  n int := 0;
begin
  for c in select s.id from public.safety_checkins s
            where s.released_at is null and s.due_at <= now()
            order by s.due_at limit 500 loop
    n := n + kw.release_checkin(c.id);
  end loop;
  delete from public.safety_checkins where released_at < now() - interval '7 days';
  return n;
end $$;

select cron.schedule('kithwall-safety-checkins', '* * * * *', $$select kw.release_due_checkins()$$);

-- ---------------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------------
revoke execute on function kw.release_checkin(uuid), kw.release_due_checkins() from public, anon, authenticated;
revoke execute on function public.create_safety_checkin(timestamptz, boolean, jsonb), public.safety_check_in(uuid),
  public.safety_checkin_alert_now(uuid) from public, anon;
grant execute on function public.create_safety_checkin(timestamptz, boolean, jsonb), public.safety_check_in(uuid),
  public.safety_checkin_alert_now(uuid) to authenticated;

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
