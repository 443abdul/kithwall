/**
 * Audience epoch records (security review K1).
 *
 * Only a key authority (the audience owner; for groups, events and conversations also an active admin)
 * may mint the key for a new epoch. When it does, it publishes a commitment to the key signed with its
 * identity key. Anyone may then relay the key to a member (the database only allows members to do so),
 * and every recipient checks that what it received is exactly the key the authority minted: a member,
 * or the server, can no longer hand out a key of its own for an epoch.
 *
 *   commit = b64u(SHA-256(lp("kithwall/v1/epoch-commit", audienceId, epoch, key)))
 *   sig    = Ed25519(IK_sig of rotatedBy,
 *                    canonicalJson({ d:"kithwall/v1/epoch-record", audienceId, epoch, rotatedBy, commit }))
 *
 * The commitment is a hash of a fresh 32-byte random key, so it reveals nothing about the key.
 */
import { invalid } from './errors';
import { assertBytes, assertString, b64u, canonicalJson, ctEqual, decodeFixed, lp, utf8 } from './encoding';
import { KEY_LEN, edSign, edVerifyB64, sha256 } from './primitives';

export interface EpochRecord {
  audienceId: string;
  epoch: number;
  /** User id of the key authority that minted the key. */
  rotatedBy: string;
  /** epochCommit(audienceId, epoch, key). */
  commit: string;
}

function checkEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) invalid('epoch must be a positive integer');
}

/** Commitment to an epoch key, bound to the audience and the epoch. */
export function epochCommit(audienceId: string, epoch: number, key: Uint8Array): string {
  assertString(audienceId, 'audienceId');
  checkEpoch(epoch);
  assertBytes(key, 'key', KEY_LEN);
  return b64u.encode(sha256(lp('kithwall/v1/epoch-commit', audienceId, String(epoch), key)));
}

/** Constant-time check that `key` is the key committed to. False on any malformed input. */
export function keyMatchesCommit(audienceId: string, epoch: number, key: Uint8Array, commit: string): boolean {
  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = decodeFixed(commit, 'commit', 32);
    actual = b64u.decode(epochCommit(audienceId, epoch, key));
  } catch {
    return false;
  }
  return ctEqual(actual, expected);
}

function recordMessage(rec: EpochRecord): Uint8Array {
  if (typeof rec !== 'object' || rec === null) invalid('record must be an object');
  assertString(rec.audienceId, 'audienceId');
  assertString(rec.rotatedBy, 'rotatedBy');
  checkEpoch(rec.epoch);
  decodeFixed(rec.commit, 'commit', 32);
  return utf8(canonicalJson({
    d: 'kithwall/v1/epoch-record', audienceId: rec.audienceId, epoch: rec.epoch, rotatedBy: rec.rotatedBy, commit: rec.commit,
  }));
}

/** The authority signs the record for an epoch it minted. */
export function signEpochRecord(signPriv: Uint8Array, rec: EpochRecord): string {
  return b64u.encode(edSign(recordMessage(rec), signPriv));
}

/** Never throws; false on any problem. */
export function verifyEpochRecord(signPub: Uint8Array, rec: EpochRecord, sig: string): boolean {
  let msg: Uint8Array;
  try {
    msg = recordMessage(rec);
  } catch {
    return false;
  }
  return edVerifyB64(sig, msg, signPub);
}

/**
 * Signed admin grants (security review R-K-2). Promoting someone to admin of a group, event or chat makes
 * them a key authority, so the promotion is signed by the identity key of the admin (or owner) who made it:
 *
 *   sig = Ed25519(IK_sig of grantedBy, canonicalJson({ d:"kithwall/v1/admin-grant", audienceId, memberId, grantedBy }))
 *
 * Clients count an admin as a key authority only when a chain of valid grants leads back to the audience
 * owner, each checked against the PINNED identity key of its signer, so the server cannot make a puppet
 * an admin.
 */
export interface AdminGrant {
  audienceId: string;
  memberId: string;
  grantedBy: string;
}

function grantMessage(g: AdminGrant): Uint8Array {
  if (typeof g !== 'object' || g === null) invalid('grant must be an object');
  assertString(g.audienceId, 'audienceId');
  assertString(g.memberId, 'memberId');
  assertString(g.grantedBy, 'grantedBy');
  return utf8(canonicalJson({ d: 'kithwall/v1/admin-grant', audienceId: g.audienceId, memberId: g.memberId, grantedBy: g.grantedBy }));
}

export function signAdminGrant(signPriv: Uint8Array, g: AdminGrant): string {
  return b64u.encode(edSign(grantMessage(g), signPriv));
}

/** Never throws; false on any problem. */
export function verifyAdminGrant(signPub: Uint8Array, g: AdminGrant, sig: string): boolean {
  let msg: Uint8Array;
  try {
    msg = grantMessage(g);
  } catch {
    return false;
  }
  return edVerifyB64(sig, msg, signPub);
}

/**
 * Who added a member to an audience (roadmap 2026-11, batch 2): signed by the person who added them, so
 * key holders deliver audience keys only to members someone entitled really added. A row the server
 * inserted on its own carries no valid signature and gets no keys.
 */
export interface MemberAdd { audienceId: string; memberId: string; addedBy: string }

function memberAddMessage(g: MemberAdd): Uint8Array {
  if (typeof g !== 'object' || g === null) invalid('member add must be an object');
  assertString(g.audienceId, 'audienceId');
  assertString(g.memberId, 'memberId');
  assertString(g.addedBy, 'addedBy');
  return utf8(canonicalJson({ d: 'kithwall/v2/member-add', audienceId: g.audienceId, memberId: g.memberId, addedBy: g.addedBy }));
}

export function signMemberAdd(signPriv: Uint8Array, g: MemberAdd): string {
  return b64u.encode(edSign(memberAddMessage(g), signPriv));
}

/** Never throws; false on any problem. */
export function verifyMemberAdd(signPub: Uint8Array, g: MemberAdd, sig: unknown): boolean {
  let msg: Uint8Array;
  try { msg = memberAddMessage(g); } catch { return false; }
  return typeof sig === 'string' && edVerifyB64(sig, msg, signPub);
}
