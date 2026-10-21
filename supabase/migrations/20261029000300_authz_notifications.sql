-- Security re-review (docs/v2/06-security-review.md §10.2): N-A1 and N-A2.
--
-- N-A1 a pending join request to a closed group made its owner's profile visible to the requester and let
--      the requester send the owner notifications (and pushes), bypassing requests_from = 'nobody'
--      (kw.audience_peers and kw.shares_audience accepted members of any status). Now only active members
--      count; someone merely INVITED still sees the owner and whoever invited them, and may be notified by
--      them (the invitation itself), but a request gives no rights at all.
-- N-A2 anyone allowed to notify someone (e.g. a circle co-member) could insert notifications of ANY type with
--      made-up object ids: spam or phishing pushes. Clients may now only insert the notification types the
--      app sends, each pointing at a real object the actor caused (their comment or like on the post or
--      photo, their tag, their invitation, the friendship). Everything else is written by the server.

-- ---------------------------------------------------------------------------------------
-- N-A1
-- ---------------------------------------------------------------------------------------
create or replace function kw.audience_peers(viewer uuid, target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with mine as (
    select m.audience_id, m.status, m.invited_by from public.audience_members m
     where m.member_id = viewer and m.status in ('active', 'invited')
    union all
    select x.id, 'owner', null::uuid from public.audiences x
     where x.owner_id = viewer and x.kind in ('list', 'group', 'event', 'conversation')
  )
  select exists (
    select 1 from mine join public.audiences x on x.id = mine.audience_id
     where (mine.status in ('active', 'owner')
            and (x.owner_id = target
                 or exists (select 1 from public.audience_members m where m.audience_id = x.id and m.member_id = target)))
        or (mine.status = 'invited' and (x.owner_id = target or mine.invited_by = target))
  )
$$;

create or replace function kw.shares_audience(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.audience_members m1
                 join public.audience_members m2 on m2.audience_id = m1.audience_id
                 where m1.member_id = a and m2.member_id = b and m1.status = 'active' and m2.status in ('active', 'invited'))
      or exists (select 1 from public.audiences x join public.audience_members m on m.audience_id = x.id
                 where x.kind in ('group', 'event', 'conversation')
                   and ((x.owner_id = a and m.member_id = b and m.status in ('active', 'invited'))
                        or (x.owner_id = b and m.member_id = a and m.status = 'active')))
$$;

-- ---------------------------------------------------------------------------------------
-- N-A2
-- ---------------------------------------------------------------------------------------
-- Is this client-made notification about something real that the actor did? (Server-made notifications,
-- e.g. security_notice, recovery_request, post_published, are inserted by definer code and skip RLS.)
create function kw.notification_ok(p_type text, p_kind text, p_object uuid, p_actor uuid, p_recipient uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare post record; photo record;
begin
  if p_object is null or p_actor is null or p_recipient is null then return false; end if;
  case p_type
    when 'friend_request' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.friendships f
        where f.user_a = least(p_actor, p_recipient) and f.user_b = greatest(p_actor, p_recipient));
    when 'friend_accept' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.friendships f
        where f.user_a = least(p_actor, p_recipient) and f.user_b = greatest(p_actor, p_recipient) and f.status = 'accepted');
    when 'recovery_trustee' then
      return p_kind = 'profile' and p_object = p_actor
         and exists (select 1 from public.recovery_shares s where s.owner_id = p_actor and s.trustee_id = p_recipient);
    when 'group_invite' then
      return p_kind = 'group' and exists (select 1 from public.groups g
        join public.audience_members m on m.audience_id = g.audience_id and m.member_id = p_recipient and m.status in ('invited', 'active')
       where g.id = p_object and kw.is_member(g.audience_id, p_actor));
    when 'event_invite' then
      return p_kind = 'event' and exists (select 1 from public.events e
        join public.audience_members m on m.audience_id = e.audience_id and m.member_id = p_recipient and m.status in ('invited', 'active')
       where e.id = p_object and kw.is_member(e.audience_id, p_actor));
    when 'tag' then
      return p_kind = 'photo' and exists (select 1 from public.tag_notices t
        where t.photo_id = p_object and t.tagged_id = p_recipient and t.tagger_id = p_actor);
    when 'comment', 'like' then
      if p_kind = 'post' then
        select x.id, x.author_id into post from public.posts x where x.id = p_object;
        if not found then return false; end if;
        if p_type = 'like' then
          return p_recipient = post.author_id and exists (select 1 from public.likes l
            where l.target_kind = 'post' and l.target_id = p_object and l.user_id = p_actor);
        end if;
        -- the post's author, or someone whose comment on it the actor replied to
        return exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_actor)
           and (p_recipient = post.author_id
                or exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_recipient));
      elsif p_kind = 'photo' then
        select x.id, x.owner_id into photo from public.photos x where x.id = p_object;
        if not found or p_recipient <> photo.owner_id then return false; end if;
        if p_type = 'like' then
          return exists (select 1 from public.likes l where l.target_kind = 'photo' and l.target_id = p_object and l.user_id = p_actor);
        end if;
        return exists (select 1 from public.comments c where c.photo_id = p_object and c.author_id = p_actor);
      end if;
      return false;
    else
      return false;
  end case;
end $$;
revoke execute on function kw.notification_ok(text, text, uuid, uuid, uuid) from public, anon;
grant execute on function kw.notification_ok(text, text, uuid, uuid, uuid) to authenticated, service_role;

create policy "notifications describe something real" on public.notifications as restrictive
  for insert to authenticated with check (kw.notification_ok(type, object_kind, object_id, actor_id, recipient_id));
