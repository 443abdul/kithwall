-- Security review D3 (docs/v2/06-security-review.md): every signed-in user could list every profile
-- (handle, id, account age, moderation status, public keys), which made discoverable = false meaningless
-- and handed out the UUIDs that D2 needed. Brief principle 4 promises a profile visible only to
-- connections.
--
-- Now a profile row is visible only to:
--   * its owner, and staff (moderation);
--   * people who are not blocked either way AND who are connected to it:
--       - a friendship row exists (accepted, or a pending request either way),
--       - a mutual connection (friend of a friend: their names appear on comments, likes and tags in
--         posts both can read, and their signatures must be verifiable),
--       - they share an audience (circle, event, chat): active members and owners see every member;
--         someone only invited/requesting sees the owner and whoever invited them,
--       - the profile's owner sent them a notification, or they are each other's trusted friends,
--       - discoverable = true (the opt-in directory), or public posts/pages when the Public audience is on.
-- Everyone else finds a person only by typing their EXACT handle: public.find_profile() returns that one
-- row (rate-limited, no wildcards, nothing listable). That covers search-by-handle, invite links (the
-- invite creates a pending request, which makes the inviter visible) and profile links.

create function kw.audience_peers(viewer uuid, target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with mine as (
    select m.audience_id, m.status, m.invited_by from public.audience_members m where m.member_id = viewer
    union all
    select x.id, 'owner', null::uuid from public.audiences x
     where x.owner_id = viewer and x.kind in ('list', 'group', 'event', 'conversation')
  )
  select exists (
    select 1 from mine join public.audiences x on x.id = mine.audience_id
     where (mine.status in ('active', 'owner')
            and (x.owner_id = target
                 or exists (select 1 from public.audience_members m where m.audience_id = x.id and m.member_id = target)))
        or (mine.status not in ('active', 'owner') and (x.owner_id = target or mine.invited_by = target))
  )
$$;

create function kw.can_see_profile(target uuid, viewer uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = '' as $$
  select viewer is not null and target is not null and (
    target = viewer
    or kw.is_staff(viewer)
    or (not kw.is_blocked(viewer, target) and (
         exists (select 1 from public.profiles p where p.id = target and p.discoverable)
      or exists (select 1 from public.friendships f
                  where f.user_a = least(viewer, target) and f.user_b = greatest(viewer, target))
      or exists (select 1 from public.friendships f1
                   join public.friendships f2
                     on f2.status = 'accepted'
                    and f2.user_a = least(case when f1.user_a = viewer then f1.user_b else f1.user_a end, target)
                    and f2.user_b = greatest(case when f1.user_a = viewer then f1.user_b else f1.user_a end, target)
                  where f1.status = 'accepted' and (f1.user_a = viewer or f1.user_b = viewer))
      or kw.audience_peers(viewer, target)
      or exists (select 1 from public.notifications n where n.recipient_id = viewer and n.actor_id = target)
      or exists (select 1 from public.recovery_shares s
                  where (s.owner_id = viewer and s.trustee_id = target) or (s.owner_id = target and s.trustee_id = viewer))
      or (kw.public_enabled()
          and (exists (select 1 from public.posts x where x.author_id = target and x.is_public)
               or exists (select 1 from public.pages g where g.owner_id = target)))
    ))
  )
$$;

drop policy "signed-in users see profiles unless blocked" on public.profiles;
create policy "see yourself, your connections and people you share with" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or kw.can_see_profile(id));

-- Exact-handle lookup: the only way to reach someone you are not connected to yet.
create function public.find_profile(p_handle text)
returns table (id uuid, username text, discoverable boolean, display_name_public text, sign_pub text, kx_pub text, key_version int)
language plpgsql security definer set search_path = '' as $$
declare h text := lower(btrim(coalesce(p_handle, '')));
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if h !~ '^[a-z0-9][a-z0-9.]{2,29}$' then return; end if;
  perform kw.rate_limit('profile_lookup', 300, interval '1 hour');
  return query
    select p.id, p.username::text, p.discoverable, p.display_name_public, p.sign_pub, p.kx_pub, p.key_version
      from public.profiles p
     where p.username = h::extensions.citext
       and (p.id = auth.uid() or not kw.is_blocked(auth.uid(), p.id))
       and kw.mfa_ok();
end $$;

revoke execute on function kw.audience_peers(uuid, uuid), kw.can_see_profile(uuid, uuid) from public, anon;
grant execute on function kw.audience_peers(uuid, uuid), kw.can_see_profile(uuid, uuid) to authenticated, service_role;
revoke execute on function public.find_profile(text) from public, anon;
grant execute on function public.find_profile(text) to authenticated, service_role;
