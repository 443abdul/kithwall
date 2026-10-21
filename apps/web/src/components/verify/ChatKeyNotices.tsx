'use client';
// Key notices at the top of a chat (security review K1 / K2):
//  * 1:1 chats: the other person's "safety number changed" notice (KeyChangeBanner).
//  * any chat: a warning when someone handed this device a key for the chat that contradicts the signed
//    key record of its owner (lib/keys/keyring.ts conflicts). The key was rejected, not used.
import { useT } from '@/i18n';
import { Icon } from '@/components/ui/Icon';
import { useKeyConflicts } from '@/lib/keys/keyring';
import { people, usePeopleVersion } from '@/lib/people';
import { KeyChangeBanner } from './KeyChangeBanner';

export function ChatKeyNotices({ audienceId, peer, name }: { audienceId: string; peer: string | null; name: string }) {
  const t = useT();
  usePeopleVersion();
  const conflicts = useKeyConflicts(audienceId);
  const handle = peer ? people.get(peer)?.username ?? null : null;
  return (
    <>
      {peer && handle ? <KeyChangeBanner userId={peer} name={name} handle={handle} /> : null}
      {conflicts.length ? (
        <div className="k-keychange" role="alert" data-testid="key-conflict">
          <Icon name="alert" />
          <div className="k-stack-sm">
            <p className="k-keychange-title">{t('keys.conflictTitle')}</p>
            <p className="k-small">{t('keys.conflictBody')}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
