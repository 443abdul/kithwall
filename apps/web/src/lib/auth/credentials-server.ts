import 'server-only';
// Security review W2 / K2: server helpers for actions that change how someone gets into an account or
// what their identity is. A bearer token alone (XSS, a token read from a seized unlocked device) must not
// be enough: the caller also proves possession of the identity key, which only an unlocked device holds.
import { b64u, verifyChallenge } from '@kithwall/crypto';
import { admin, claimNotice, siteOrigin } from './server';
import { mailConfigured, sendNotice } from './mailer';
import { noticeAddress } from './passkey-server';

/** The nonce a device signs to prove key possession while adding a passkey (bound to that ceremony). */
export const addPasskeyNonce = (webauthnChallenge: string) => `kithwall/v1/add-passkey/${webauthnChallenge}`;

/** Verify a proof-of-key signature over `nonce` against the caller's published identity key. */
export async function verifyKeyProof(userId: string, nonce: string, signature: unknown): Promise<boolean> {
  if (typeof signature !== 'string' || signature.length > 200) return false;
  const { data: prof } = await admin().from('profiles').select('sign_pub').eq('id', userId).maybeSingle();
  if (!prof) return false;
  try { return verifyChallenge(b64u.decode(prof.sign_pub as string), nonce, signature); } catch { return false; }
}

const SUBJECT: Record<'passkey' | 'passphrase' | 'identity', string> = {
  passkey: 'A passkey was added to your Kithwall account',
  passphrase: 'A passphrase was set on your Kithwall account',
  identity: 'Your Kithwall identity key was changed',
};
const BODY: Record<'passkey' | 'passphrase' | 'identity', string> = {
  passkey: 'A new passkey can now sign in to your Kithwall account.',
  passphrase: 'Your Kithwall account can now be opened with a passphrase.',
  identity: 'Your Kithwall identity key was replaced (signed with your previous key). Your contacts will see that your safety number changed.',
};

/**
 * Tell every device of the account (in-app notification + push via the notifications trigger) and the
 * notice address that a new way in was added. Content-free; never throws.
 */
export async function noticeSecurityChange(req: Request, userId: string, what: 'passkey' | 'passphrase' | 'identity', refId: string): Promise<void> {
  // In-app (and push) for new sign-in methods; an identity change is made on the user's own unlocked
  // device and every other device has to unlock again anyway.
  if (what !== 'identity') {
    try {
      const { error } = await admin().from('notifications').insert({ recipient_id: userId, actor_id: userId, type: 'security_notice' });
      if (error) console.error('security notice', error.message);
    } catch (e) { console.error('security notice', e); }
  }
  try {
    const to = await noticeAddress(userId);
    const kind = what === 'identity' ? 'identity_key_changed' : 'credential_added';
    if (to && mailConfigured() && await claimNotice(kind, refId, userId)) {
      await sendNotice(to, SUBJECT[what],
        `${BODY[what]}\n\nIf this was you, there's nothing to do. If it wasn't, sign in at ${siteOrigin(req)}, ` +
        `remove passkeys you don't recognise under You > Settings > Security, sign out other sessions and make a new recovery key.\n\n— Kithwall`);
    }
  } catch (e) { console.error('security notice email', e); }
}
