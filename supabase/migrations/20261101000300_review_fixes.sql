-- Fixes from the review of batches 1 and 2 (docs/v2/roadmap-2026-11.md).
--
-- 1. Stories to close friends: kw.can_story only accepted the friends audience or a circle, so every story
--    shared with the close friends list (an audiences.kind = 'list' audience the author owns) was refused.
create or replace function kw.can_story(s public.stories) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare aud record;
begin
  if s.author_id is distinct from auth.uid() or not kw.is_active() then return false; end if;
  select owner_id, kind into aud from public.audiences where id = s.audience_id;
  if not found then return false; end if;
  if s.group_id is null then
    return aud.owner_id = auth.uid() and aud.kind in ('friends', 'list');
  end if;
  if not kw.is_member(s.audience_id) then return false; end if;
  return aud.kind = 'group'
     and exists (select 1 from public.groups g where g.id = s.group_id and g.audience_id = s.audience_id);
end $$;

-- 2. post_votes follows the same second-factor rule as every other user-data table.
select kw.require_mfa('public.post_votes');

-- 3. Proof of earlier membership for signed member additions (apps/web/src/lib/keys/authority.ts). A member
--    without a valid addition signature is still accepted when a key authority once sealed this audience's
--    key to them: the sealed box's Ed25519 signature (by the sealer, over the audience, epoch and recipient)
--    is something the server cannot forge. Members of an audience may read the deliveries made to the
--    members they ask about (ciphertext, readable only by the recipient), at most a few per member.
create function public.member_key_proofs(p_aud uuid, p_members uuid[])
returns table (member_id uuid, epoch int, sealed_by uuid, sealed jsonb)
language sql stable security definer set search_path = '' as $$
  select k.recipient_id, k.epoch, k.sealed_by, k.sealed
  from (
    select k.*, row_number() over (partition by k.recipient_id order by k.epoch) as rn
    from public.audience_keys k
    where k.audience_id = p_aud and k.recipient_id = any (p_members[1:200]) and k.sealed_by <> k.recipient_id
  ) k
  where k.rn <= 3
    and (kw.is_member(p_aud) or kw.audience_owner(p_aud) = auth.uid())
$$;
revoke execute on function public.member_key_proofs(uuid, uuid[]) from public, anon;
grant execute on function public.member_key_proofs(uuid, uuid[]) to authenticated;
