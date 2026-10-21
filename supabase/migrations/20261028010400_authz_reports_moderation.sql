-- Security review D4, L2, L3, L7 (docs/v2/06-security-review.md).
--
-- D4: reports against groups, events, pages and profiles were accepted without checking that the target
--     exists or that the reporter can see it, and kept the reporter-supplied target_owner_id and
--     stored_envelope ("server-captured evidence"). Someone could frame anyone with a fabricated report.
--     Now every kind is validated, target_owner_id is always derived by the server, stored_envelope is
--     only ever a server copy of a real row, and workflow columns can't be pre-filled.
-- L2: moderators could undo admin bans, act against staff, and rewrite a report's target. Restoring a
--     banned account and any action against a staff member are admin-only; report targets are immutable.
-- L3: an inviter could reset an invite's use count and push out its expiry; redeem_invite skipped the
--     active-account and block checks.
-- L7: scheduling account deletion skipped the two-step (aal2) requirement.

-- ---------------------------------------------------------------------------------------
-- D4 + L2: reports
-- ---------------------------------------------------------------------------------------
create or replace function kw.reports_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare seen boolean := false; owner uuid; env jsonb;
begin
  if tg_op = 'INSERT' then
    perform kw.rate_limit('report', 50, interval '1 day');
    new.created_at := now();
    -- Workflow and evidence columns are the server's, never the reporter's.
    new.status := 'open'; new.moderator_id := null; new.decision_note := null; new.resolved_at := null;
    new.stored_envelope := null; new.target_owner_id := null;
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
    elsif new.target_kind = 'group' then
      select kw.can_see_audience(g.audience_id) or (g.privacy = 'open' and kw.public_enabled()), null::jsonb, kw.audience_owner(g.audience_id)
        into seen, env, owner from public.groups g where g.id = new.target_id;
    elsif new.target_kind = 'event' then
      select kw.can_see_audience(e.audience_id) or (e.is_public and kw.public_enabled())
               or (e.group_id is not null and kw.is_circle_member(e.group_id)),
             null::jsonb, e.host_id
        into seen, env, owner from public.events e where e.id = new.target_id;
    elsif new.target_kind = 'page' then
      select kw.public_enabled() or g.owner_id = auth.uid(), null::jsonb, g.owner_id
        into seen, env, owner from public.pages g where g.id = new.target_id;
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
     or new.target_kind <> old.target_kind
     -- (target_owner_id may only go to null: the FK clears it when that account is deleted)
     or (new.target_owner_id is distinct from old.target_owner_id and new.target_owner_id is not null)
     or new.reason <> old.reason or new.details is distinct from old.details or new.created_at <> old.created_at then
    raise exception 'report evidence is immutable';
  end if;
  return new;
end $$;

create or replace function kw.apply_moderation_action() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cur text;
begin
  if auth.uid() is not null then
    if new.target_user_id = auth.uid() then
      raise exception 'staff cannot act on their own account' using errcode = '42501';
    end if;
    if kw.is_staff(new.target_user_id) and not kw.is_admin() then
      raise exception 'only admins can act on staff accounts' using errcode = '42501';
    end if;
  end if;
  select status into cur from public.profiles where id = new.target_user_id;
  if new.action = 'suspend' then
    if cur = 'banned' and auth.uid() is not null and not kw.is_admin() then
      raise exception 'only admins can change a ban' using errcode = '42501';
    end if;
    update public.profiles set status = 'suspended', suspended_until = coalesce(new.expires_at, now() + interval '7 days')
     where id = new.target_user_id;
  elsif new.action = 'ban' then
    if auth.uid() is not null and not kw.is_admin() then raise exception 'only admins can ban' using errcode = '42501'; end if;
    update public.profiles set status = 'banned', suspended_until = null where id = new.target_user_id;
  elsif new.action = 'restore' then
    if cur = 'banned' and auth.uid() is not null and not kw.is_admin() then
      raise exception 'only admins can lift a ban' using errcode = '42501';
    end if;
    update public.profiles set status = 'active', suspended_until = null where id = new.target_user_id;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------
-- L3: invites
-- ---------------------------------------------------------------------------------------
create or replace function public.redeem_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv record; me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into inv from public.invites where code = invite_code for update;
  if not found or inv.expires_at < now() or inv.uses >= inv.max_uses then
    raise exception 'invite is invalid or expired';
  end if;
  if inv.inviter_id = me then return inv.inviter_id; end if;
  if not kw.is_active(me) or not kw.is_active(inv.inviter_id) or kw.is_blocked(me, inv.inviter_id) then
    raise exception 'invite is invalid or expired';
  end if;
  perform set_config('kw.redeeming', 'on', true);
  update public.invites set uses = uses + 1 where code = invite_code;
  perform set_config('kw.redeeming', 'off', true);
  insert into public.friendships (user_a, user_b, requested_by)
    values (least(me, inv.inviter_id), greatest(me, inv.inviter_id), me)
    on conflict do nothing;
  return inv.inviter_id;
end $$;

-- Inviters may shorten or revoke an invite, never extend or reset it. The redeem path (above) updates
-- `uses` with the redeemer's auth.uid() still set, so it marks itself with kw.redeeming.
create function kw.invites_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.uses := 0;
    new.created_at := now();
    new.expires_at := least(coalesce(new.expires_at, now() + interval '30 days'), now() + interval '30 days');
    return new;
  end if;
  if current_setting('kw.redeeming', true) = 'on' and new.uses = old.uses + 1
     and new.code = old.code and new.inviter_id = old.inviter_id and new.expires_at = old.expires_at
     and new.max_uses = old.max_uses and new.created_at = old.created_at then
    return new;
  end if;
  if new.code <> old.code or new.inviter_id <> old.inviter_id or new.uses <> old.uses
     or new.expires_at > old.expires_at or new.max_uses > old.max_uses or new.created_at <> old.created_at then
    raise exception 'invites can only be shortened or revoked' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger invites_guard before insert or update on public.invites
  for each row execute function kw.invites_guard();

-- ---------------------------------------------------------------------------------------
-- L7: scheduling account deletion needs the second step when one is enrolled.
-- ---------------------------------------------------------------------------------------
create or replace function public.request_account_deletion() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); at timestamptz;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not kw.mfa_ok() then raise exception 'two-step verification required' using errcode = '42501'; end if;
  perform kw.rate_limit('account_deletion_request', 5, interval '1 day');
  insert into public.account_deletion_requests (user_id, execute_after)
    values (me, now() + interval '72 hours')
    on conflict (user_id) do nothing;
  select execute_after into at from public.account_deletion_requests where user_id = me;
  return at;
end $$;

revoke execute on function kw.invites_guard() from public, anon, authenticated;
