// Which audience keys a device may adopt (security review K1). Pure: no React, no Supabase, so it is
// unit-tested in Node (authority.test.ts) and used by the keyring for every sealed key it receives.
//
// The old rule was "the first key whose signature verifies against sealed_by wins", so any member (or the
// operator, through a puppet profile) could hand out a key of their own, including keys planted for
// future epochs that every client then adopted after a rotation. Now a key is adopted only when:
//
//  1. its seal verifies against the sealer's identity key (checked by the caller with openSealed), and
//  2. a valid signed epoch record exists for (audience, epoch), made by a key authority, and the key
//     matches that record's commitment (packages/crypto/src/epoch.ts). Any member may relay such a key;
//     a key that does not match is a CONFLICT: it is rejected and surfaced as a security warning; or
//  3. there is no (valid) record, which is the case for epochs that predate records, and the SEALER is a
//     key authority: the audience owner (friends / self / list), or the owner or an active admin
//     (group / event / conversation). For conversations, past epochs relayed by a current member are
//     accepted too (history from before this change), never the current epoch.
//
// Anything else waits: the authority's own delivery (or its record) will arrive.
import { b64u, keyMatchesCommit, verifyEpochRecord } from '@kithwall/crypto';

export type AudienceKind = 'friends' | 'list' | 'group' | 'event' | 'conversation' | 'self';

export interface AudienceMeta { id: string; kind: AudienceKind; owner_id: string; current_epoch: number }

export interface Roster {
  /** Active admins (role = 'admin', status = 'active'). */
  admins: ReadonlySet<string>;
  /** Active members (any role). */
  members: ReadonlySet<string>;
}

export interface EpochRecordRow { audience_id: string; epoch: number; rotated_by: string; commit: string; sig: string }

export type KeyVerdict =
  | { ok: true; via: 'record' | 'authority' | 'history' }
  | { ok: false; reason: 'wait' | 'conflict' };

/** Who may mint keys for this audience right now. */
export function isKeyAuthority(aud: AudienceMeta, roster: Roster, userId: string): boolean {
  if (aud.owner_id === userId) return true;
  if (aud.kind === 'friends' || aud.kind === 'self' || aud.kind === 'list') return false;
  return roster.admins.has(userId);
}

/** Is this record signed by the identity it names, and (for the current epoch) by a current authority? */
export function recordIsValid(aud: AudienceMeta, roster: Roster, rec: EpochRecordRow, rotatorSignPub: string | null): boolean {
  if (!rotatorSignPub || rec.audience_id !== aud.id) return false;
  let pub: Uint8Array;
  try { pub = b64u.decode(rotatorSignPub); } catch { return false; }
  if (!verifyEpochRecord(pub, { audienceId: rec.audience_id, epoch: rec.epoch, rotatedBy: rec.rotated_by, commit: rec.commit }, rec.sig)) return false;
  // The current epoch must come from someone who is an authority now. Older epochs may have been
  // minted by an owner or admin who has since left (their record still verifies).
  if (rec.epoch >= aud.current_epoch && !isKeyAuthority(aud, roster, rec.rotated_by)) return false;
  return true;
}

export function judgeKey(args: {
  aud: AudienceMeta | null;
  roster: Roster;
  epoch: number;
  sealedBy: string;
  key: Uint8Array;
  record: EpochRecordRow | null;
  /** Current identity key (base64url) of the record's rotator, if known. */
  rotatorSignPub: string | null;
}): KeyVerdict {
  const { aud, roster, epoch, sealedBy, key, record } = args;
  // We can't see the audience (left it, or not loaded yet): nothing to decide against.
  if (!aud) return { ok: false, reason: 'wait' };
  // Keys for epochs that don't exist yet are never adopted (the database refuses them too).
  if (epoch > aud.current_epoch) return { ok: false, reason: 'conflict' };
  if (record && record.epoch === epoch && recordIsValid(aud, roster, record, args.rotatorSignPub)) {
    return keyMatchesCommit(aud.id, epoch, key, record.commit) ? { ok: true, via: 'record' } : { ok: false, reason: 'conflict' };
  }
  if (isKeyAuthority(aud, roster, sealedBy)) return { ok: true, via: 'authority' };
  if (aud.kind === 'conversation' && epoch < aud.current_epoch && roster.members.has(sealedBy)) return { ok: true, via: 'history' };
  return { ok: false, reason: 'wait' };
}
