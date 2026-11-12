-- Kithwall 2: likes and reactions on comments.
--
-- The likes table has always accepted a comment as its target (20261017000003_content.sql), readable and
-- writable by whoever can read the comment's post, with an optional sealed emoji. What was missing is telling
-- the comment's author: a new notification type, 'comment_like', about the POST the comment is on (so the
-- notice opens the thread). As with every notice, the database checks that it is true: the actor really
-- liked a comment of the recipient's on that post.

do $$
declare def text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c
   where c.conrelid = 'public.notifications'::regclass and c.conname = 'notifications_type_check';
  if def is null then raise exception 'notifications_type_check is missing'; end if;
  if position('''comment_like''' in def) = 0 then
    def := replace(def, 'ARRAY[', 'ARRAY[''comment_like''::text, ');
    alter table public.notifications drop constraint notifications_type_check;
    execute 'alter table public.notifications add constraint notifications_type_check ' || def;
  end if;
end $$;

-- As in 20261112000100_follow_public.sql, plus 'comment_like' between two readers of the same post.
create or replace function kw.open_notify_ok(p_type text, p_kind text, p_object uuid, p_actor uuid, p_recipient uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_type = 'follow' then
    return exists (select 1 from public.follows f where f.follower_id = p_actor and f.followee_id = p_recipient);
  elsif p_type = 'mention' then
    return kw.may_mention(p_actor, p_recipient);
  elsif p_type = 'comment_like' and p_kind = 'post' then
    -- two readers of the same post, whatever its audience: people who comment under a friend's post are
    -- often not connected to each other (kw.notification_ok checks the like is real)
    return kw.can_read_post(p_object, p_actor) and kw.can_read_post(p_object, p_recipient);
  elsif p_type in ('like', 'comment', 'share') and p_kind = 'post' then
    -- a Followers or Public post both can read (kw.notification_ok checks the like / comment / repost is real)
    return exists (select 1 from public.posts x
                    where x.id = p_object and x.wall_owner_id is not null
                      and (x.is_public or kw.audience_kind(x.audience_id) = 'followers')
                      and kw.can_read_post(x.id, p_actor) and kw.can_read_post(x.id, p_recipient));
  end if;
  return false;
end $$;

-- As in 20261112000100_follow_public.sql, plus 'comment_like'.
create or replace function kw.notification_ok(p_type text, p_kind text, p_object uuid, p_actor uuid, p_recipient uuid) returns boolean
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
    when 'follow' then
      return p_kind = 'profile' and p_object = p_actor and exists (select 1 from public.follows f
        where f.follower_id = p_actor and f.followee_id = p_recipient);
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
    when 'comment_like' then
      -- the author of a comment on this post, told by someone who really liked that comment
      return p_kind = 'post' and exists (
        select 1 from public.likes l join public.comments c on c.id = l.target_id
         where l.target_kind = 'comment' and l.user_id = p_actor and c.post_id = p_object and c.author_id = p_recipient);
    when 'share' then
      -- the original's author, told by someone who really reposted it
      return p_kind = 'post' and exists (select 1 from public.posts o where o.id = p_object and o.author_id = p_recipient)
         and exists (select 1 from public.posts s where s.shared_post_id = p_object and s.author_id = p_actor and s.kind = 'share');
    when 'mention' then
      -- a post the actor wrote or commented on, which the mentioned person can read and allows mentions from
      -- (the @handle itself is inside the ciphertext, so the server can't check it)
      return p_kind = 'post' and p_recipient <> p_actor and kw.can_read_post(p_object, p_recipient)
         and kw.may_mention(p_actor, p_recipient)
         and (exists (select 1 from public.posts x where x.id = p_object and x.author_id = p_actor)
              or exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_actor));
    else
      return false;
  end case;
end $$;
