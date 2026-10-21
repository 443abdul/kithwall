'use client';
// Proof-of-key (spec §3.9) for the browser: get a fresh single-use server nonce for a purpose and sign it
// with the unlocked identity key. Used for account deletion, adding a sign-in method (security review W2)
// and identity-key rotation (K2).
import { signChallenge } from '@kithwall/crypto';
import { sb } from '../supabase';
import { identity } from './session';

export type ProofPurpose = 'delete_account' | 'add_credential' | 'rotate_identity';

export async function proveKey(purpose: ProofPurpose): Promise<{ challengeId: string; signature: string }> {
  const { data, error } = await sb().rpc('create_key_challenge', { purpose });
  if (error) throw new Error(error.code === 'P0429' ? 'rate' : error.message);
  const ch = (Array.isArray(data) ? data[0] : data) as { id: string; nonce: string } | undefined;
  if (!ch) throw new Error('No confirmation was issued. Please try again.');
  return { challengeId: ch.id, signature: signChallenge(identity().signPriv, ch.nonce) };
}

/** Signature binding the passkey being added to this unlocked identity (see lib/auth/credentials-server.ts). */
export function addPasskeyProof(webauthnChallenge: string): string {
  return signChallenge(identity().signPriv, `kithwall/v1/add-passkey/${webauthnChallenge}`);
}
