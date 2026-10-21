// Who a key delivery may be re-sealed to when I rotate my identity key (keyring.resealMine). Pure: unit-tested.
// Security final review NEW-1 (docs/v2/06-security-review.md §12): re-sealing used to read the published
// kx_pub directly, so an operator who swapped a recipient's key received every key I had ever delivered.
// Now only recipients that passed sealGate (pinned, confirmed or vouched keys) get a new seal.
import { b64u } from '@kithwall/crypto';

/** The key to seal to, or null to skip this recipient (unknown, or their identity key change isn't trusted). */
export function resealTarget(
  recipientId: string,
  me: string,
  myNextKxPub: Uint8Array,
  published: ReadonlyMap<string, { s: string; x: string }>,
  allowed: ReadonlySet<string>,
): Uint8Array | null {
  if (recipientId === me) return myNextKxPub;
  const p = published.get(recipientId);
  if (!p || !allowed.has(recipientId)) return null;
  return b64u.decode(p.x);
}
