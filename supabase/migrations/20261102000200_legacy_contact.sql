-- Legacy contact (docs/v2/03-safety.md §11, roadmap 2026-11 item C2).
--
-- A person picks one of their connections as their legacy contact, an inactivity period (3, 6 or 12 months)
-- and, optionally, a farewell note. The note is sealed on their device to the contact's identity key with the
-- hybrid X25519 + ML-KEM-768 sealed box (packages/crypto seal v2) and signed by the owner, and a second copy
-- is sealed to the owner's own key so they can read and change it later. The server stores ciphertext only.
--
-- While the owner keeps opening the app, nothing happens: the signed-in app calls legacy_seen() at most once
-- a day, which moves last_active_on (a date, nothing finer) to today. Activity is tracked ONLY for people who
-- have a legacy contact, and only in their own row. A daily job (/api/cron/legacy → legacy_tick(), service
-- role only) reminds the owner about 30 and 7 days before the end of the period and, at least 7 days after the
-- last reminder, marks the row released and tells the contact. Only then can the contact fetch the sealed note
-- (legacy_note()), decrypt it on their device, and choose to remember the account (profiles.memorialised_at):
-- the profile says "Remembering <name>", birthday reminders stop, and new connection requests and new chats to
-- the account are refused. Existing content keeps its audiences. If the owner opens the app again, release and
-- remembrance are cleared at once and the contact gets a quiet in-app notice.
--
-- Before release the contact can only see that they were chosen (legacy_for_me()), never the ciphertext or the
-- owner's activity. Nobody else can see the row at all. The operator controls WHEN a note is released (and
-- could release it early or never), but can never read it: only the contact's device can open it.

create table public.legacy_contacts (
  owner_id uuid primary key references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.profiles (id) on delete cascade,
  inactive_months smallint not null check (inactive_months in (3, 6, 12)),
  -- Sealed to the contact (context legacy-note/<owner>/<contact>) and to the owner (legacy-note-self/<owner>).
  sealed_note jsonb check (sealed_note is null or (jsonb_typeof(sealed_note) = 'object' and octet_length(sealed_note::text) <= 40000)),
  sealed_self jsonb check (sealed_self is null or (jsonb_typeof(sealed_self) = 'object' and octet_length(sealed_self::text) <= 40000)),
  -- The contact's X25519 public key the note was sealed to (lets the owner's device notice a key change and
  -- reseal, and the contact's device pick the right key after a rotation).
  note_kx text check (note_kx is null or note_kx ~ '^[A-Za-z0-9_-]{43}$'),
  last_active_on date not null default current_date,
  reminders smallint not null default 0 check (reminders between 0 and 2),
  reminded_on date,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_id <> owner_id),
  check ((sealed_note is null) = (sealed_self is null) and (sealed_note is null) = (note_kx is null))
);
create index legacy_contacts_contact on public.legacy_contacts (contact_id);
create index legacy_contacts_pending on public.legacy_contacts (last_active_on) where released_at is null;
alter table public.legacy_contacts enable row level security;

-- The owner reads their own row. The contact never reads the table: they get the minimum through the
-- functions below. Every write goes through the RPCs.
create policy "owner reads own legacy contact" on public.legacy_contacts for select to authenticated
  using (owner_id = auth.uid());
select kw.require_mfa('public.legacy_contacts');
revoke all on table public.legacy_contacts from anon;
revoke insert, update, delete, truncate, references, trigger on table public.legacy_contacts from authenticated;

-- "Remembering <name>". Visible to whoever may see the profile; set only by the legacy contact after release
-- (remember_account) and cleared when the owner comes back (legacy_seen).
alter table public.profiles add column memorialised_at timestamptz;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create function kw.is_memorialised(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = u and p.memorialised_at is not null)
$$;

-- The last day of the inactivity period (mirrored in apps/web/src/lib/legacy/model.ts legacyDueOn).
create function kw.legacy_due(last_active date, months int) returns date
language sql immutable set search_path = '' as $$
  select (last_active + make_interval(months => months))::date
$$;

-- Only the legacy functions below (which set kw.legacy for the statement) may change memorialised_at.
create function kw.profiles_memorial_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(current_setting('kw.legacy', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    new.memorialised_at := null;
  elsif new.memorialised_at is distinct from old.memorialised_at then
    raise exception 'only a legacy contact can remember an account' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_memorial_guard before insert or update of memorialised_at on public.profiles
  for each row execute function kw.profiles_memorial_guard();

-- A remembered account takes no new connections (requests, invite links) ...
create function kw.legacy_friendships_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if kw.is_memorialised(new.user_a) or kw.is_memorialised(new.user_b) then
    raise exception 'remembered_account' using errcode = '42501',
      hint = 'This account is being remembered and does not take new connections.';
  end if;
  return new;
end $$;
create trigger friendships_memorial_guard before insert on public.friendships
  for each row execute function kw.legacy_friendships_guard();

-- ... and nobody can start a new chat with it or add it to one. Existing chats stay as they are.
create function kw.legacy_members_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or new.member_id = auth.uid() or not kw.is_memorialised(new.member_id) then return new; end if;
  if exists (select 1 from public.audiences a where a.id = new.audience_id and a.kind = 'conversation') then
    raise exception 'remembered_account' using errcode = '42501',
      hint = 'This account is being remembered and does not take new chats.';
  end if;
  return new;
end $$;
create trigger audience_members_memorial_guard before insert on public.audience_members
  for each row execute function kw.legacy_members_guard();

-- No longer connected (removed, or blocked: blocking deletes the friendship) = no longer the legacy contact.
-- The owner is told when the other person ended the connection, except after a block (which is never revealed)
-- or while an account is being deleted.
create function kw.legacy_on_unfriend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    delete from public.legacy_contacts l
     where (l.owner_id = old.user_a and l.contact_id = old.user_b) or (l.owner_id = old.user_b and l.contact_id = old.user_a)
    returning l.owner_id, l.contact_id
  loop
    if auth.uid() = r.contact_id and not kw.is_blocked(r.owner_id, r.contact_id)
       and exists (select 1 from public.profiles p where p.id = r.owner_id)
       and exists (select 1 from public.profiles p where p.id = r.contact_id) then
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        values (r.owner_id, r.contact_id, 'legacy_cleared', 'profile', r.owner_id);
    end if;
  end loop;
  return old;
end $$;
create trigger friendships_legacy_cleanup after delete on public.friendships
  for each row execute function kw.legacy_on_unfriend();

-- Notification types (all written by the definer code here; clients cannot insert them, see
-- kw.notification_ok) and the reminder email kind.
select kw.extend_check('public.notifications', 'notifications_type_check',
  array['legacy_contact', 'legacy_declined', 'legacy_cleared', 'legacy_reminder', 'legacy_released', 'legacy_active']);
select kw.extend_check('public.notice_emails', 'notice_emails_kind_check', array['legacy_reminder']);

-- ---------------------------------------------------------------------------------------------
-- Owner RPCs
-- ---------------------------------------------------------------------------------------------

-- Choose or change the legacy contact, period and (sealed) note. Saving counts as activity: the period
-- starts again today and any release is undone. A new contact is told they were chosen.
create function public.set_legacy_contact(p_contact uuid, p_months int, p_note jsonb, p_self jsonb, p_note_kx text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  prev uuid;
begin
  if uid is null or not kw.mfa_ok() or not kw.is_active(uid) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_months is null or p_months not in (3, 6, 12) then
    raise exception 'choose 3, 6 or 12 months' using errcode = '22023';
  end if;
  if p_contact is null or p_contact = uid or not kw.is_friend(uid, p_contact) or kw.is_blocked(uid, p_contact)
     or not kw.is_active(p_contact) or kw.is_memorialised(p_contact) then
    raise exception 'choose one of your connections' using errcode = '42501';
  end if;
  if (p_note is null) <> (p_self is null) or (p_note is null) <> (p_note_kx is null)
     or (p_note is not null and (jsonb_typeof(p_note) <> 'object' or jsonb_typeof(p_self) <> 'object')) then
    raise exception 'malformed note' using errcode = '22023';
  end if;
  perform kw.rate_limit('legacy_contact', 30, interval '1 day');

  select l.contact_id into prev from public.legacy_contacts l where l.owner_id = uid for update;
  insert into public.legacy_contacts (owner_id, contact_id, inactive_months, sealed_note, sealed_self, note_kx)
    values (uid, p_contact, p_months, p_note, p_self, p_note_kx)
  on conflict (owner_id) do update set
    contact_id = excluded.contact_id, inactive_months = excluded.inactive_months,
    sealed_note = excluded.sealed_note, sealed_self = excluded.sealed_self, note_kx = excluded.note_kx,
    last_active_on = current_date, reminders = 0, reminded_on = null, released_at = null, updated_at = now(),
    created_at = case when public.legacy_contacts.contact_id = excluded.contact_id then public.legacy_contacts.created_at else now() end;
  if prev is distinct from p_contact then
    insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
      values (p_contact, uid, 'legacy_contact', 'profile', uid);
  end if;
end $$;

create function public.remove_legacy_contact() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  delete from public.legacy_contacts where owner_id = auth.uid();
end $$;

-- "I'm here": called by the signed-in app at most once a day. Moves the period on, and if the note had been
-- released (or the account remembered), takes all of that back and quietly tells the contact.
-- Returns {legacy: has a legacy contact, returned: a release was undone}.
create function public.legacy_seen() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r record;
  has boolean;
  back boolean := false;
begin
  if uid is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into r from public.legacy_contacts l where l.owner_id = uid for update;
  has := found;
  if has then
    back := r.released_at is not null;
    if r.last_active_on < current_date or r.reminders > 0 or back then
      update public.legacy_contacts
         set last_active_on = current_date, reminders = 0, reminded_on = null, released_at = null
       where owner_id = uid;
    end if;
    if back then
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        values (r.contact_id, uid, 'legacy_active', 'profile', uid);
    end if;
  end if;
  if kw.is_memorialised(uid) then
    perform set_config('kw.legacy', 'on', true);
    update public.profiles set memorialised_at = null where id = uid;
    perform set_config('kw.legacy', 'off', true);
  end if;
  return jsonb_build_object('legacy', has, 'returned', back);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Contact RPCs
-- ---------------------------------------------------------------------------------------------

-- Who chose me. Before release: only who and since when. After release: also when, and whether there is a note.
create function public.legacy_for_me()
returns table (owner_id uuid, chosen_at timestamptz, released_at timestamptz, has_note boolean)
language sql stable security definer set search_path = '' as $$
  select l.owner_id, l.created_at, l.released_at,
         case when l.released_at is not null then l.sealed_note is not null end
    from public.legacy_contacts l
   where l.contact_id = auth.uid() and kw.mfa_ok()
   order by l.created_at
$$;

-- The sealed note, to the contact only, and only after release. Decrypted on the contact's device.
create function public.legacy_note(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('sealed', l.sealed_note, 'kx', l.note_kx, 'released_at', l.released_at)
    from public.legacy_contacts l
   where l.owner_id = p_owner and l.contact_id = auth.uid() and l.released_at is not null and kw.mfa_ok()
$$;

-- Step back (before release). The owner is told kindly and can choose someone else.
create function public.decline_legacy_contact(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not kw.mfa_ok() then raise exception 'not authorised' using errcode = '42501'; end if;
  delete from public.legacy_contacts where owner_id = p_owner and contact_id = uid and released_at is null;
  if not found then raise exception 'nothing to decline' using errcode = 'P0002'; end if;
  insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
    values (p_owner, uid, 'legacy_declined', 'profile', p_owner);
end $$;

-- After release, the contact may remember the account (or stop remembering it).
create function public.remember_account(p_owner uuid, p_on boolean) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); at timestamptz;
begin
  if uid is null or not kw.mfa_ok() or not kw.is_active(uid) then raise exception 'not authorised' using errcode = '42501'; end if;
  if not exists (select 1 from public.legacy_contacts l
                  where l.owner_id = p_owner and l.contact_id = uid and l.released_at is not null) then
    raise exception 'only their legacy contact can do this, after the note is released' using errcode = '42501';
  end if;
  perform set_config('kw.legacy', 'on', true);
  update public.profiles set memorialised_at = case when coalesce(p_on, false) then coalesce(memorialised_at, now()) end
   where id = p_owner returning memorialised_at into at;
  perform set_config('kw.legacy', 'off', true);
  return at;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Daily job (service role only; /api/cron/legacy)
-- ---------------------------------------------------------------------------------------------
-- Reminders at about 30 and 7 days before the end of the period (each as an in-app notification, which
-- also sends the push), then release no earlier than the end of the period AND 7 days after the last
-- reminder, so a missed run never releases without a week's warning. Returns what happened, so the route
-- can email reminders to owners who set up a notice address:
--   [{kind: 'reminder', owner_id, notification_id, days} | {kind: 'released', owner_id, contact_id, notification_id}]
create function public.legacy_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  due date;
  days int;
  nid uuid;
  out jsonb := '[]'::jsonb;
begin
  for r in select l.* from public.legacy_contacts l where l.released_at is null order by l.last_active_on for update skip locked loop
    due := kw.legacy_due(r.last_active_on, r.inactive_months);
    days := due - current_date;
    if days <= 7 and r.reminders < 2 then
      update public.legacy_contacts set reminders = 2, reminded_on = current_date where owner_id = r.owner_id;
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        values (r.owner_id, r.owner_id, 'legacy_reminder', 'profile', r.owner_id) returning id into nid;
      out := out || jsonb_build_object('kind', 'reminder', 'owner_id', r.owner_id, 'notification_id', nid, 'days', 7);
    elsif days <= 30 and days > 7 and r.reminders < 1 then
      update public.legacy_contacts set reminders = 1, reminded_on = current_date where owner_id = r.owner_id;
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        values (r.owner_id, r.owner_id, 'legacy_reminder', 'profile', r.owner_id) returning id into nid;
      out := out || jsonb_build_object('kind', 'reminder', 'owner_id', r.owner_id, 'notification_id', nid, 'days', days);
    elsif r.reminders = 2 and current_date >= due and current_date >= r.reminded_on + 7
          and kw.is_friend(r.owner_id, r.contact_id) and not kw.is_blocked(r.owner_id, r.contact_id) then
      update public.legacy_contacts set released_at = now() where owner_id = r.owner_id;
      insert into public.notifications (recipient_id, actor_id, type, object_kind, object_id)
        values (r.contact_id, r.owner_id, 'legacy_released', 'profile', r.owner_id) returning id into nid;
      out := out || jsonb_build_object('kind', 'released', 'owner_id', r.owner_id, 'contact_id', r.contact_id, 'notification_id', nid);
    end if;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------------
revoke execute on function kw.is_memorialised(uuid), kw.legacy_due(date, int), kw.profiles_memorial_guard(),
  kw.legacy_friendships_guard(), kw.legacy_members_guard(), kw.legacy_on_unfriend() from public, anon, authenticated;
revoke execute on function public.set_legacy_contact(uuid, int, jsonb, jsonb, text), public.remove_legacy_contact(),
  public.legacy_seen(), public.legacy_for_me(), public.legacy_note(uuid), public.decline_legacy_contact(uuid),
  public.remember_account(uuid, boolean), public.legacy_tick() from public, anon;
grant execute on function public.set_legacy_contact(uuid, int, jsonb, jsonb, text), public.remove_legacy_contact(),
  public.legacy_seen(), public.legacy_for_me(), public.legacy_note(uuid), public.decline_legacy_contact(uuid),
  public.remember_account(uuid, boolean) to authenticated;
revoke execute on function public.legacy_tick() from authenticated;
grant execute on function public.legacy_tick() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Data map (docs/v2/03-transparency.md; supabase/tests/transparency.test.sql fails on unclassified columns)
-- ---------------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.legacy_contacts', 'account', 't.owner_id = $1 or t.contact_id = $1', 'created_at', null,
   'Until you remove your legacy contact, they step back, you are no longer connected, or either of you deletes the account',
   'Your legacy contact, the inactivity period you chose, the last day you opened Kithwall, and your farewell note sealed so only they can open it once it is released.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.legacy_contacts', 'owner_id', 'id', null),
  ('public.legacy_contacts', 'contact_id', 'id', 'the connection you chose'),
  ('public.legacy_contacts', 'inactive_months', 'plaintext', 'how long Kithwall waits: 3, 6 or 12 months'),
  ('public.legacy_contacts', 'sealed_note', 'ciphertext', 'your farewell note, sealed to your legacy contact'),
  ('public.legacy_contacts', 'sealed_self', 'ciphertext', 'the same note, sealed to you so you can change it'),
  ('public.legacy_contacts', 'note_kx', 'plaintext', 'the public key the note is sealed to'),
  ('public.legacy_contacts', 'last_active_on', 'time', 'the last day you opened Kithwall (the day only; kept only while you have a legacy contact)'),
  ('public.legacy_contacts', 'reminders', 'plaintext', 'how many reminders were sent in this period'),
  ('public.legacy_contacts', 'reminded_on', 'time', null),
  ('public.legacy_contacts', 'released_at', 'time', 'when the note was passed on'),
  ('public.legacy_contacts', 'created_at', 'time', null),
  ('public.legacy_contacts', 'updated_at', 'time', null),
  ('public.profiles', 'memorialised_at', 'time', 'when your legacy contact chose to remember your account');
