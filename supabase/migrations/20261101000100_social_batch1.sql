-- Social features, batch 1 (docs/v2/roadmap-2026-11.md). Everything a person writes stays ciphertext:
--
-- 1. post_votes: one encrypted poll choice per person per post. The envelope is sealed on the voter's
--    device under HKDF(post content key, "vote", voter id) and signed by the voter, so only people who can
--    read the post can read (and tally) the votes, and nobody can forge someone else's vote. The server
--    sees that a person voted on a post, not what they picked.
-- 2. likes.sealed: an optional encrypted reaction (which emoji) on a like, sealed the same way under
--    HKDF(content key, "reaction", user id). A like without it is a plain heart.
--
-- Reposts (posts.kind = 'share' with shared_post_id), close friends (an audiences.kind = 'list' audience)
-- and per-field profile visibility need no schema change; saved posts, mutes and drafts live in the vault.

create table public.post_votes (
  post_id uuid not null references public.posts (id) on delete cascade,
  voter_id uuid not null references public.profiles (id) on delete cascade,
  envelope jsonb not null check (octet_length(envelope::text) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, voter_id)
);
create index post_votes_voter on public.post_votes (voter_id);
alter table public.post_votes enable row level security;

create policy "see votes on readable posts" on public.post_votes
  for select to authenticated using (kw.can_read_post(post_id));
create policy "vote on readable posts" on public.post_votes
  for insert to authenticated with check (voter_id = auth.uid() and kw.is_active() and kw.can_read_post(post_id));
create policy "change my vote" on public.post_votes
  for update to authenticated using (voter_id = auth.uid())
  with check (voter_id = auth.uid() and kw.is_active() and kw.can_read_post(post_id));
create policy "withdraw my vote" on public.post_votes
  for delete to authenticated using (voter_id = auth.uid());

grant select, insert, update, delete on public.post_votes to authenticated;

alter table public.likes add column sealed jsonb check (sealed is null or octet_length(sealed::text) <= 2048);

-- Transparency data map (supabase/tests/transparency.test.sql fails on any unclassified column).
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('public.post_votes', 'content', 't.voter_id = $1', 'created_at', null, 'Until you take the vote back, the post is deleted, or you delete your account', 'Your poll choices, encrypted.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.post_votes', 'post_id', 'id', null), ('public.post_votes', 'voter_id', 'id', null),
  ('public.post_votes', 'envelope', 'ciphertext', 'which option you picked'),
  ('public.post_votes', 'created_at', 'time', null), ('public.post_votes', 'updated_at', 'time', null),
  ('public.likes', 'sealed', 'ciphertext', 'which reaction you picked');

-- Notifications for reposts and @mentions (kw.notification_ok, 20261029000300_authz_notifications.sql, only
-- accepted the types the app sent until now). Same function with two more checked cases.
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
    when 'share' then
      -- the original's author, told by someone who really reposted it
      return p_kind = 'post' and exists (select 1 from public.posts o where o.id = p_object and o.author_id = p_recipient)
         and exists (select 1 from public.posts s where s.shared_post_id = p_object and s.author_id = p_actor and s.kind = 'share');
    when 'mention' then
      -- a post the actor wrote or commented on, which the mentioned person can read (the @handle itself is
      -- inside the ciphertext, so the server can't check it; this keeps mentions to real conversations)
      return p_kind = 'post' and p_recipient <> p_actor and kw.can_read_post(p_object, p_recipient)
         and (exists (select 1 from public.posts x where x.id = p_object and x.author_id = p_actor)
              or exists (select 1 from public.comments c where c.post_id = p_object and c.author_id = p_actor));
    else
      return false;
  end case;
end $$;
