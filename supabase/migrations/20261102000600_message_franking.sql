-- Message franking (roadmap item 10, docs/v2/03-franking.md): reports of chat messages that the reporter
-- can't forge and the sender can't deny, while the server still can't read any message nobody reports.
--
--  1. The sender's device picks a fresh franking key fk for every message (and every edit), seals it INSIDE
--     the encrypted payload, and sends commit = HMAC-SHA-256(fk, "kithwall/v1/frank\n" ‖ body) next to the
--     ciphertext (messages.frank_commit, 32 bytes). body is the canonical JSON of the conversation id, the
--     message id, the sender id and the payload without fk (packages/crypto/src/franking.ts). commit is a
--     PRF output under a random key: it tells the server nothing about the message.
--  2. On insert (and on an edit that brings a new commitment) the database binds commit to the sender, the
--     conversation, the message id and its own clock: frank_tag = HMAC-SHA-256(server key, "kithwall/v1/
--     frank-tag\n" ‖ conv ‖ id ‖ sender ‖ time ‖ commit). The server key is 32 random bytes generated right
--     here, in a schema the Data API can't reach, read only by the SECURITY DEFINER functions below. Nobody
--     manages it as a secret; it never leaves the database.
--  3. Recipients check commit against the payload they decrypted and fk (lib/chat/franking.ts); a message
--     whose commitment doesn't match shows as "couldn't be verified".
--  4. A report may include the message: the reporter's device sends the body, fk, commit and the tag with
--     its binding. reports_guard checks commit (HMAC under fk) and the binding (the row, or the tag when the
--     message has since been edited, unsent or has disappeared) and records the outcome in reports.frank,
--     which moderators see as verified / couldn't be verified. Only what the reporter deliberately submits
--     is ever plaintext on the server.
--  5. Server notices carry no content and no commitment. Unsend wipes the commitment with the ciphertext.
--     Safety check-in alerts are sealed in advance, so they carry their commitment from the start and are
--     tagged when they are released. Reactions are not franked (see the design doc).
--  6. app_settings.franking_required (off): once every supported app sends commitments, an admin can make
--     the database refuse new messages and edits without one, closing the "pretend to be an old app"
--     downgrade.

-- ---------------------------------------------------------------------------------------
-- 1. The server's franking key
-- ---------------------------------------------------------------------------------------
create schema kw_secret;
revoke all on schema kw_secret from public, anon, authenticated, service_role;

-- Keys are never deleted while reports may still need them; a new row rotates (new tags use the newest
-- key, verification accepts any key in the table).
create table kw_secret.franking_keys (
  kid smallint generated always as identity primary key,
  key bytea not null check (octet_length(key) = 32),
  created_at timestamptz not null default now()
);
revoke all on table kw_secret.franking_keys from public, anon, authenticated, service_role;
insert into kw_secret.franking_keys (key) values (extensions.gen_random_bytes(32));

-- ---------------------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------------------
-- 32 bytes as unpadded base64url (43 characters); anything else is refused.
create function kw.b64u32(t text) returns bytea
language plpgsql immutable set search_path = '' as $$
begin
  if t is null or t !~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' then
    raise exception 'expected 32 bytes as base64url' using errcode = '22023';
  end if;
  return decode(translate(t, '-_', '+/') || '=', 'base64');
end $$;

create function kw.b64u(b bytea) returns text
language sql immutable set search_path = '' as $$
  select rtrim(translate(replace(encode(b, 'base64'), chr(10), ''), '+/', '-_'), '=')
$$;

-- The binding MAC. `at` enters as whole microseconds since the epoch, exactly what Postgres stores.
create function kw.frank_mac(k bytea, conv uuid, msg uuid, sender uuid, at timestamptz, cm bytea) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.hmac(
    convert_to('kithwall/v1/frank-tag' || chr(10) || conv::text || chr(10) || msg::text || chr(10) || sender::text
               || chr(10) || ((extract(epoch from at) * 1000000)::bigint)::text || chr(10), 'UTF8') || cm,
    k, 'sha256')
$$;

-- Tag a commitment with the newest key. Never callable by users: it would mint proof for anything.
create function kw.frank_tag(conv uuid, msg uuid, sender uuid, at timestamptz, cm bytea) returns text
language plpgsql stable security definer set search_path = '' as $$
declare k bytea;
begin
  select f.key into k from kw_secret.franking_keys f order by f.kid desc limit 1;
  if k is null then raise exception 'no franking key'; end if;
  return kw.b64u(kw.frank_mac(k, conv, msg, sender, at, cm));
end $$;

create function kw.frank_tag_ok(tag bytea, conv uuid, msg uuid, sender uuid, at timestamptz, cm bytea) returns boolean
language sql stable security definer set search_path = '' as $$
  select tag is not null and exists (select 1 from kw_secret.franking_keys f
                                      where kw.frank_mac(f.key, conv, msg, sender, at, cm) = tag)
$$;

create function kw.franking_required() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.value = 'true'::jsonb from public.app_settings a where a.key = 'franking_required'), false)
$$;

insert into public.app_settings (key, value) values ('franking_required', 'false'::jsonb) on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------
-- 3. Messages
-- ---------------------------------------------------------------------------------------
alter table public.messages
  add column frank_commit text check (frank_commit ~ '^[A-Za-z0-9_-]{43}$'),
  add column frank_tag text check (frank_tag ~ '^[A-Za-z0-9_-]{43}$');

-- Runs after messages_guard / messages_edit_guard (row triggers fire in name order), so created_at and
-- edited_at already hold the server's clock. A client-supplied frank_tag is always replaced.
create function kw.messages_frank() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cm bytea;
begin
  if tg_op = 'UPDATE' and new.envelope is not distinct from old.envelope then
    new.frank_commit := old.frank_commit;
    new.frank_tag := old.frank_tag;
    return new;
  end if;
  -- A new version of the content needs a new commitment; keeping the old one would bind the old text.
  if new.frank_commit is null or new.notice is not null or new.unsent_at is not null
     or (tg_op = 'UPDATE' and new.frank_commit is not distinct from old.frank_commit) then
    if new.notice is null and new.unsent_at is null and auth.uid() is not null and not kw.trusted_write()
       and kw.franking_required() then
      raise exception 'messages must carry a franking commitment' using errcode = '22023';
    end if;
    new.frank_commit := null;
    new.frank_tag := null;
    return new;
  end if;
  cm := kw.b64u32(new.frank_commit);
  new.frank_commit := kw.b64u(cm);
  new.frank_tag := kw.frank_tag(new.conversation_id, new.id, new.sender_id, coalesce(new.edited_at, new.created_at), cm);
  return new;
end $$;
create trigger messages_seal_frank before insert or update on public.messages
  for each row execute function kw.messages_frank();

-- ---------------------------------------------------------------------------------------
-- 4. Safety check-in alerts carry their commitment until release
-- ---------------------------------------------------------------------------------------
alter table public.safety_checkin_alerts
  add column frank_commit text check (frank_commit ~ '^[A-Za-z0-9_-]{43}$');

-- As in 20261024000500_safety_checkins.sql, plus each alert's frank_commit.
create or replace function public.create_safety_checkin(p_due timestamptz, p_repeat boolean, p_alerts jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  a jsonb;
  conv record;
  aid uuid;
  ep int;
  fc text;
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
      fc := case when a ->> 'frank_commit' is null then null else kw.b64u(kw.b64u32(a ->> 'frank_commit')) end;
    exception when others then
      raise exception 'malformed alert' using errcode = '22023';
    end;
    if fc is null and kw.franking_required() then
      raise exception 'messages must carry a franking commitment' using errcode = '22023';
    end if;
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
    insert into public.safety_checkin_alerts (id, checkin_id, owner_id, conversation_id, epoch, envelope, frank_commit)
      values (aid, cid, uid, conv.id, ep, a -> 'envelope', fc);
  end loop;
  return cid;
end $$;

-- As before, plus the commitment (tagged by messages_seal_frank at release time). The insert is a trusted
-- write: an alert armed before commitments were required must still go out.
create or replace function kw.release_checkin(p_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  a record;
  n int := 0;
begin
  select * into r from public.safety_checkins s where s.id = p_id and s.released_at is null for update skip locked;
  if not found then return 0; end if;
  perform set_config('kw.trusted_write', 'on', true);
  for a in select * from public.safety_checkin_alerts x where x.checkin_id = r.id order by x.created_at loop
    if exists (select 1 from public.conversations c where c.id = a.conversation_id)
       and not kw.dm_blocked(a.conversation_id)
       and not exists (select 1 from public.messages m where m.id = a.id) then
      insert into public.messages (id, conversation_id, sender_id, epoch, envelope, frank_commit)
        values (a.id, a.conversation_id, a.owner_id, a.epoch, a.envelope, a.frank_commit);
      n := n + 1;
    end if;
  end loop;
  perform set_config('kw.trusted_write', 'off', true);
  delete from public.safety_checkin_alerts where checkin_id = r.id;
  update public.safety_checkins set released_at = now() where id = r.id;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------
-- 5. Reports
-- ---------------------------------------------------------------------------------------
-- The server's verdict on a reported message's franking evidence (never the reporter's):
--   {state: 'verified', sender, conv, at}   commitment and binding check out
--   {state: 'failed', why}                  evidence present but wrong: treat the report with caution
--   {state: 'none'}                         the message was included without evidence (older app, or a message
--                                           sent before franking): it couldn't be verified
--   {state: 'not_included'}                 the reporter chose not to include the message
alter table public.reports add column frank jsonb;

create function kw.report_frank(target uuid, disclosed jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ev jsonb := disclosed -> 'frank';
  r_conv uuid; r_sender uuid; r_commit text; r_at timestamptz;
  fk bytea; cm bytea; tg bytea; b text; body jsonb;
  v_conv uuid; v_sender uuid; v_at timestamptz;
begin
  if disclosed is null or jsonb_typeof(disclosed) <> 'object' then return jsonb_build_object('state', 'not_included'); end if;
  if ev is null or jsonb_typeof(ev) <> 'object' then return jsonb_build_object('state', 'none'); end if;
  select m.conversation_id, m.sender_id, m.frank_commit, coalesce(m.edited_at, m.created_at)
    into r_conv, r_sender, r_commit, r_at from public.messages m where m.id = target;
  begin
    fk := kw.b64u32(ev ->> 'fk');
    cm := kw.b64u32(ev ->> 'commit');
    b := ev ->> 'body';
    if b is null or octet_length(b) > 131072 then raise exception 'body'; end if;
    body := b::jsonb;
  exception when others then
    return jsonb_build_object('state', 'failed', 'why', 'malformed');
  end;
  if r_commit is not null and kw.b64u32(r_commit) = cm then
    -- The version the server still holds: the row itself is the binding.
    v_conv := r_conv; v_sender := r_sender; v_at := r_at;
  else
    -- An earlier version, or a message that has been unsent or has disappeared: the tag is the binding.
    begin
      tg := kw.b64u32(ev ->> 'tag');
      v_conv := (ev ->> 'conv')::uuid;
      v_sender := (ev ->> 'sender')::uuid;
      v_at := (ev ->> 'at')::timestamptz;
    exception when others then
      return jsonb_build_object('state', 'failed', 'why', 'malformed');
    end;
    if (r_conv is not null and (v_conv <> r_conv or v_sender <> r_sender))
       or not kw.frank_tag_ok(tg, v_conv, target, v_sender, v_at, cm) then
      return jsonb_build_object('state', 'failed', 'why', 'binding');
    end if;
  end if;
  if extensions.hmac(convert_to('kithwall/v1/frank' || chr(10) || b, 'UTF8'), fk, 'sha256') <> cm then
    return jsonb_build_object('state', 'failed', 'why', 'commitment');
  end if;
  if jsonb_typeof(body) <> 'object' or body -> 'v' is distinct from '1'::jsonb
     or body ->> 'conv' is distinct from v_conv::text or body ->> 'id' is distinct from target::text
     or body ->> 'sender' is distinct from v_sender::text or jsonb_typeof(body -> 'payload') is distinct from 'object' then
    return jsonb_build_object('state', 'failed', 'why', 'body');
  end if;
  return jsonb_build_object('state', 'verified', 'sender', v_sender, 'conv', v_conv, 'at', v_at);
end $$;

-- As in 20261030000100_drop_classic.sql, plus franking: reports.frank is the server's; verified evidence lets
-- someone report a message that has since been unsent or has disappeared, or a chat they were removed from
-- (the tag proves the sender sent it there; fk and the plaintext prove the reporter's device received it).
create or replace function kw.reports_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare seen boolean := false; owner uuid; env jsonb;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('report', 50, interval '1 day');
    new.created_at := now();
    -- Workflow and evidence columns are the server's, never the reporter's.
    new.status := 'open'; new.moderator_id := null; new.decision_note := null; new.resolved_at := null;
    new.stored_envelope := null; new.target_owner_id := null; new.frank := null;
    if auth.uid() is null then return new; end if;   -- service role (tests, migrations)
    if new.target_kind = 'post' then
      select kw.can_read_post(p.id), p.envelope, p.author_id into seen, env, owner from public.posts p where p.id = new.target_id;
    elsif new.target_kind = 'comment' then
      select kw.can_read_target('comment', c.id), c.envelope, c.author_id into seen, env, owner from public.comments c where c.id = new.target_id;
    elsif new.target_kind = 'photo' then
      select kw.can_read_photo(p.id), p.envelope, p.owner_id into seen, env, owner from public.photos p where p.id = new.target_id;
    elsif new.target_kind = 'message' then
      select kw.is_member(kw.conversation_audience(m.conversation_id)), m.envelope, m.sender_id into seen, env, owner
        from public.messages m where m.id = new.target_id;
      new.frank := kw.report_frank(new.target_id, new.disclosed);
      if new.frank ->> 'state' = 'verified' then
        seen := true;
        if owner is null then
          select p.id into owner from public.profiles p where p.id = (new.frank ->> 'sender')::uuid;
        end if;
      end if;
    elsif new.target_kind = 'group' then
      select kw.can_see_audience(g.audience_id) or (g.privacy = 'open' and kw.public_enabled()), null::jsonb, kw.audience_owner(g.audience_id)
        into seen, env, owner from public.groups g where g.id = new.target_id;
    elsif new.target_kind = 'event' then
      select kw.can_see_audience(e.audience_id) or (e.is_public and kw.public_enabled())
               or (e.group_id is not null and kw.is_circle_member(e.group_id)),
             null::jsonb, e.host_id
        into seen, env, owner from public.events e where e.id = new.target_id;
    elsif new.target_kind = 'profile' then
      select kw.can_see_profile(p.id), null::jsonb, p.id into seen, env, owner from public.profiles p where p.id = new.target_id;
    end if;
    if not coalesce(seen, false) then
      raise exception 'cannot report what you cannot see' using errcode = '42501';
    end if;
    new.stored_envelope := env;
    new.target_owner_id := owner;
    return new;
  end if;
  if new.status <> old.status and new.status <> 'open' then
    new.moderator_id := auth.uid(); new.resolved_at := now();
  end if;
  if new.reporter_id <> old.reporter_id or new.disclosed is distinct from old.disclosed
     or new.stored_envelope is distinct from old.stored_envelope or new.target_id <> old.target_id
     or new.target_kind <> old.target_kind or new.frank is distinct from old.frank
     -- (target_owner_id may only go to null: the FK clears it when that account is deleted)
     or (new.target_owner_id is distinct from old.target_owner_id and new.target_owner_id is not null)
     or new.reason <> old.reason or new.details is distinct from old.details or new.created_at <> old.created_at then
    raise exception 'report evidence is immutable';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------
-- 6. Data map (20261024000900_transparency.sql) and execute rights
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.messages', 'frank_commit', 'hashed', 'a commitment to the message under a key only the chat holds, for verified reports'),
  ('public.messages', 'frank_tag', 'hashed', 'the server''s stamp binding that commitment to the sender, chat and time'),
  ('public.safety_checkin_alerts', 'frank_commit', 'hashed', 'a commitment to the alert, for verified reports'),
  ('public.reports', 'frank', 'plaintext', 'whether the reported message''s sender proof checked out');

revoke execute on function kw.b64u32(text), kw.b64u(bytea),
  kw.frank_mac(bytea, uuid, uuid, uuid, timestamptz, bytea),
  kw.frank_tag(uuid, uuid, uuid, timestamptz, bytea),
  kw.frank_tag_ok(bytea, uuid, uuid, uuid, timestamptz, bytea),
  kw.franking_required(), kw.messages_frank(), kw.report_frank(uuid, jsonb)
  from public, anon, authenticated;
