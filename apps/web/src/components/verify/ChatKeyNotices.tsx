'use client';
// Key notices at the top of a chat (security review K1 / K2, re-review R-K-1 / R-K-2):
//  * 1:1 chats: the other person's "safety number changed" notice (KeyChangeBanner).
//  * any chat: keys this device rejected (a key contradicting the owner's signed record, or one signed with
//    an identity key this device doesn't trust), and, in group chats, a prominent warning when someone new
//    can hand out the chat's keys (AudienceKeyNotices).
import { people, usePeopleVersion } from '@/lib/people';
import { KeyChangeBanner } from './KeyChangeBanner';
import { AudienceKeyNotices } from './AudienceKeyNotices';

export function ChatKeyNotices({ audienceId, peer, name, authorities }: {
  audienceId: string; peer: string | null; name: string;
  /** Group chats: the owner plus verified admins (null for 1:1 chats). */
  authorities?: string[] | null;
}) {
  usePeopleVersion();
  const handle = peer ? people.get(peer)?.username ?? null : null;
  return (
    <>
      {peer && handle ? <KeyChangeBanner userId={peer} name={name} handle={handle} /> : null}
      <AudienceKeyNotices audienceId={audienceId} authorities={peer ? null : authorities ?? null} where="chat" />
    </>
  );
}
