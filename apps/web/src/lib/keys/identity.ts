'use client';
// Signed identity-key rotation (security review K2). The ONLY way an account's identity keys change:
//  1. a new identity is generated on this unlocked device and wrapped under the same AMK (the old
//     key-exchange key is kept in the bundle so keys sealed to it still open);
//  2. the change { userId, newSignPub, newKxPub, at } is signed with the CURRENT signing key;
//  3. POST /api/account/identity-key checks a fresh proof-of-key and that signature, then swaps keys and
//     bundle atomically and logs the signed change in public.key_changes for contacts to verify;
//  4. our key deliveries and epoch records are re-signed with the new key; the session restarts.
// Contacts see "your safety number with … changed" (vouched: their device verifies the signature by the
// key it pinned). The encrypted profile info is re-signed here; other content signed with the old key
// (posts, messages) is still verified against the published key, so it shows as unverified afterwards.
// This is an emergency action, not routine, and has no button in the UI yet.
import { rotateIdentityBundle, signKeyChange, type KeyChange } from '@kithwall/crypto';
import { sb } from '../supabase';
import { adoptUnlocked, fetchBundle, getSession, me, unlockedKeys } from './session';
import { keyring } from './keyring';
import { people } from '../people';
import { proveKey } from './proof';

export async function rotateIdentityKey(): Promise<{ keyVersion: number }> {
  const userId = me();
  const bundle = await fetchBundle(userId);
  if (!bundle) throw new Error('No keys found for this account');
  const current = unlockedKeys();
  await keyring.whenReady();
  await people.ensure([userId]);
  const info = people.person(userId)?.info ?? null;   // re-signed below with the new key
  const r = rotateIdentityBundle(userId, bundle, current);
  const change: KeyChange = { userId, newSignPub: r.bundle.signPub, newKxPub: r.bundle.kxPub, at: new Date().toISOString() };
  const sig = signKeyChange(current.identity.signPriv, change);
  const proof = await proveKey('rotate_identity');
  const { data } = await sb().auth.getSession();
  const res = await fetch('/api/account/identity-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ ...proof, change, sig, bundle: r.bundle }),
  });
  const out = await res.json().catch(() => ({})) as { keyVersion?: number; error?: string };
  if (!res.ok || typeof out.keyVersion !== 'number') throw new Error(out.error ?? 'The key change failed.');
  await keyring.resealMine(r.unlocked.identity).catch((e) => console.warn('re-sealing after key change', e));
  people.forget([userId]);
  await adoptUnlocked(userId, getSession().email, r.unlocked, false);
  if (info) {
    const { saveProfileInfo } = await import('../friends');
    await saveProfileInfo(info).catch((e) => console.warn('re-signing profile info after key change', e));
  }
  return { keyVersion: out.keyVersion };
}
