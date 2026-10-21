-- Security review K2 (High): identity keys were mutable, W2 (Medium): adding a sign-in credential
-- needed only a bearer token.
--
-- K2. profiles.sign_pub / kx_pub / key_version could be changed by ANY session of the account (an aal1
-- session after an email takeover, a stolen refresh token) or by the operator, and contacts silently
-- sealed new keys to the replacement. Now:
--   * The identity columns are immutable for everyone, the service role included, except inside
--     public.apply_identity_key_change(). That function is executable by the service role only and is
--     called by POST /api/account/identity-key after the route has checked
--       - a fresh proof-of-key (purpose 'rotate_identity') signed with the CURRENT identity key,
--       - a key-change statement { userId, newSignPub, newKxPub, at } signed with the CURRENT key,
--       - aal2 when the account has an authenticator app.
--     The function swaps the keys and the key bundle in one transaction and appends the signed
--     statement to public.key_changes, where every contact's device can check it (vouchedChain).
--   * Clients can no longer write public.key_changes themselves.
--   * There is no way to change identity keys without the old key: someone who lost every device and
--     the recovery key deletes the account ("I've lost everything") and starts a new one.
--   Clients additionally pin every contact's keys (lib/keys/pins.ts) and show a "safety number
--   changed" notice for ANY change (apps/web/src/components/verify/KeyChangeBanner.tsx).
--
-- W2. New key_challenges purposes 'add_credential' (passkey add / passphrase enable) and
-- 'rotate_identity'; notice_emails kinds and a 'security_notice' notification so every device and the
-- notice address hear about a new way into the account. Constraints are extended additively (other
-- migrations may extend them too).

-- ---------------------------------------------------------------------------------------
-- 1. Identity keys are immutable except through the signed key-change function
-- ---------------------------------------------------------------------------------------
create or replace function kw.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Moderation fields can only be changed by staff (or the service role).
  if auth.uid() is not null and not kw.is_staff()
     and (new.status is distinct from old.status or new.suspended_until is distinct from old.suspended_until) then
    raise exception 'moderation fields are staff-only';
  end if;
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'profile identity is immutable';
  end if;
  if (new.sign_pub is distinct from old.sign_pub or new.kx_pub is distinct from old.kx_pub
      or new.key_version is distinct from old.key_version)
     and coalesce(current_setting('kw.identity_change', true), '') <> old.id::text then
    raise exception 'identity keys can only change through a key change signed by the old key' using errcode = '42501';
  end if;
  return new;
end $$;

drop policy if exists "owner records own key change" on public.key_changes;

-- Called by the server route after it verified the proof-of-key and the signature of p_change by the
-- current identity key. Returns the new key_version.
create function public.apply_identity_key_change(p_user uuid, p_change jsonb, p_sig text, p_bundle jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare prof record; v int;
begin
  select p.id, p.sign_pub, p.kx_pub, p.key_version into prof from public.profiles p where p.id = p_user for update;
  if not found then raise exception 'no such profile' using errcode = 'P0002'; end if;
  if p_change ->> 'userId' is distinct from p_user::text
     or p_change ->> 'oldSignPub' is distinct from prof.sign_pub then
    raise exception 'the key change does not start from the current key' using errcode = '40001';
  end if;
  if coalesce(p_change ->> 'newSignPub', '') !~ '^[A-Za-z0-9_-]{43}$' or coalesce(p_change ->> 'newKxPub', '') !~ '^[A-Za-z0-9_-]{43}$'
     or p_change ->> 'newSignPub' = prof.sign_pub or p_change ->> 'newKxPub' = prof.kx_pub
     or p_bundle ->> 'signPub' is distinct from p_change ->> 'newSignPub'
     or p_bundle ->> 'kxPub' is distinct from p_change ->> 'newKxPub'
     or coalesce(p_sig, '') !~ '^[A-Za-z0-9_-]{86}$' then
    raise exception 'malformed key change' using errcode = '22023';
  end if;
  if (select count(*) from public.key_changes k where k.user_id = p_user and k.created_at > now() - interval '1 day') >= 3 then
    raise exception 'too many key changes today' using errcode = 'P0429';
  end if;

  perform set_config('kw.identity_change', p_user::text, true);
  update public.profiles
     set sign_pub = p_change ->> 'newSignPub', kx_pub = p_change ->> 'newKxPub', key_version = key_version + 1
   where id = p_user
   returning key_version into v;
  perform set_config('kw.identity_change', '', true);

  update public.key_bundles set bundle = p_bundle, updated_at = now() where user_id = p_user;
  if not found then raise exception 'no key bundle' using errcode = 'P0002'; end if;
  insert into public.key_changes (user_id, change, sig)
    values (p_user, p_change || jsonb_build_object('version', v, 'oldKxPub', prof.kx_pub), p_sig);
  return v;
end $$;

-- ---------------------------------------------------------------------------------------
-- 2. Purposes, notice kinds and the security notification (extended additively)
-- ---------------------------------------------------------------------------------------
create function kw.extend_check(tbl regclass, con text, vals text[]) returns void
language plpgsql set search_path = '' as $$
declare def text; v text; add text := '';
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conrelid = tbl and c.conname = con;
  if def is null then raise exception 'constraint % not found', con; end if;
  foreach v in array vals loop
    if position('''' || v || '''' in def) = 0 then add := add || quote_literal(v) || '::text, '; end if;
  end loop;
  if add = '' then return; end if;
  execute format('alter table %s drop constraint %I', tbl, con);
  execute format('alter table %s add constraint %I %s', tbl, con, replace(def, 'ARRAY[', 'ARRAY[' || add));
end $$;

select kw.extend_check('public.key_challenges', 'key_challenges_purpose_check', array['add_credential', 'rotate_identity']);
select kw.extend_check('public.notice_emails', 'notice_emails_kind_check', array['credential_added', 'identity_key_changed']);
select kw.extend_check('public.notifications', 'notifications_type_check', array['security_notice']);

-- Security notices ("a passkey was added to your account") come from the server only.
create policy "security notices come from the server" on public.notifications as restrictive
  for insert to authenticated with check (type <> 'security_notice');

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function public.apply_identity_key_change(uuid, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_identity_key_change(uuid, jsonb, text, jsonb) to service_role;
revoke execute on function kw.extend_check(regclass, text, text[]) from public, anon, authenticated;
