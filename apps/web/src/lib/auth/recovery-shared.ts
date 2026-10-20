// Wire types and pure helpers for account recovery that starts from a @handle (docs/v2/01-accounts.md
// §3 "Recovering an account"). Shared by the route handlers (app/api/recovery/*) and the browser
// (lib/auth/recover-client.ts). Unit-tested in recovery-shared.test.ts.
import type { KeyBundle } from '@kithwall/crypto';
import type { Sealed } from '@kithwall/crypto';

/**
 * The parts of a key bundle a recovering device needs: the AMK wrapped by the recovery key, the
 * identity keys wrapped by the AMK, and the public keys. Never the password/passphrase wrap
 * (amkByPassword): that one is protected only by a human-chosen secret, so handing it to anyone who
 * types a handle would allow offline guessing. The recovery wrap is protected by a random 256-bit key.
 */
export type RecoveryBundle = Omit<KeyBundle, 'amkByPassword'>;

export function recoveryBundleOf(b: KeyBundle): RecoveryBundle {
  return { v: b.v, kdf: b.kdf, signPub: b.signPub, kxPub: b.kxPub, amkByRecovery: b.amkByRecovery, identityEnc: b.identityEnc, rkCommitment: b.rkCommitment };
}

/** POST /api/recovery/account */
export interface RecoverAccountReq { handle: string }
export interface RecoverAccountRes {
  userId: string;
  /** key_challenges row (purpose 'recover_account') and its nonce, signed with the identity key. */
  challengeId: string;
  nonce: string;
  bundle: RecoveryBundle;
  /** Trusted friends: how many, and how many must help (null = none chosen). Never who they are. */
  trusted: { count: number; threshold: number } | null;
}

/** POST /api/recovery/finish */
export interface RecoverFinishReq { userId: string; challengeId: string; signature: string; requestId?: string }
export interface RecoverFinishRes { tokenHash: string }

/** POST /api/recovery/friends/start */
export interface FriendsStartReq { handle: string; ephPub: string }
export interface FriendsStartRes { requestId: string; notBefore: string; expiresAt: string; threshold: number; trustees: number }

/** POST /api/recovery/friends/status and /cancel */
export interface FriendsStatusReq { requestId: string }
export interface FriendsStatusRes {
  status: 'pending' | 'cancelled' | 'completed';
  notBefore: string;
  expiresAt: string;
  ephPub: string;
  threshold: number;
  responses: { trusteeId: string; signPub: string; sealed: Sealed }[];
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A typed recovery phrase: lower-case words separated by single spaces (order kept). */
export function cleanPhrase(raw: string): { phrase: string; words: number } {
  const words = raw.trim().toLowerCase().split(/[\s,.;:·•]+/u).filter(Boolean);
  return { phrase: words.join(' '), words: words.length };
}
