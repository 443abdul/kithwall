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
import { b64u, keyMatchesCommit, verifyAdminGrant, verifyEpochRecord } from '@kithwall/crypto';
import type { SignerTrust } from './pinsCore';

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

/** An audience_members row as far as admin grants are concerned. */
export interface GrantRow { member_id: string; role: string; grant_by?: string | null; grant_sig?: string | null }

/**
 * Admins whose promotion is backed by a chain of signed grants leading to the audience owner (security
 * review R-K-2), each signature checked against the signer's TRUSTED identity key (`signPubOf`, which
 * resolves through this device's pins, R-K-1). Admins without a valid chain (made by the server, or
 * promoted before grants existed) are not key authorities on this device.
 */
export function verifiedAdmins(aud: Pick<AudienceMeta, 'id' | 'owner_id'>, rows: readonly GrantRow[], signPubOf: (id: string) => string | null | undefined): Set<string> {
  const ok = new Set<string>();
  const pending = rows.filter((r) => r.role === 'admin' && r.member_id !== aud.owner_id && r.grant_by && r.grant_sig);
  let progress = true;
  while (progress) {
    progress = false;
    for (const r of pending) {
      if (ok.has(r.member_id)) continue;
      const by = r.grant_by!;
      if (by !== aud.owner_id && !ok.has(by)) continue;
      const pubB64 = signPubOf(by);
      if (!pubB64) continue;
      let pub: Uint8Array;
      try { pub = b64u.decode(pubB64); } catch { continue; }
      if (verifyAdminGrant(pub, { audienceId: aud.id, memberId: r.member_id, grantedBy: by }, r.grant_sig!)) { ok.add(r.member_id); progress = true; }
    }
  }
  return ok;
}

/** The identity key this device trusts for a person, and how (lib/keys/pins.ts resolveSigners). */
export interface TrustedSigner { s: string; trust: SignerTrust }

export type IncomingResult =
  | { ok: true; key: Uint8Array; via: 'record' | 'authority' | 'history' }
  | {
    ok: false;
    /** wait: retry later (also while a signer's identity change is unconfirmed); conflict: contradicts the record;
     *  unverified: the seal doesn't verify against the sealer's trusted key. */
    reason: 'wait' | 'conflict' | 'unverified';
    /** Set when an unconfirmed identity-key change (no signed chain from the pin) stopped this key: show the
     *  "safety number changed" warning for that person. */
    identity?: string;
  };

/**
 * Security review R-K-1: judge one sealed key delivery using only TRUSTED identity keys. The seal is opened
 * against the sealer's trusted key and the epoch record verified against the rotator's trusted key, so a key
 * the server published for someone (operator or database compromise) cannot get a key adopted. `open` tries
 * to unseal with a given sealer signing key (null when the signature or decryption fails).
 */
export function judgeIncoming(args: {
  aud: AudienceMeta | null;
  roster: Roster;
  epoch: number;
  sealedBy: string;
  record: EpochRecordRow | null;
  signer: (id: string) => TrustedSigner | null;
  open: (sealerSignPub: string) => Uint8Array | null;
}): IncomingResult {
  const sp = args.signer(args.sealedBy);
  if (!sp) return { ok: false, reason: 'wait' };
  const key = args.open(sp.s);
  if (!key) {
    return sp.trust === 'unvouched' ? { ok: false, reason: 'wait', identity: args.sealedBy } : { ok: false, reason: 'unverified' };
  }
  const rot = args.record ? args.signer(args.record.rotated_by) : null;
  const v = judgeKey({
    aud: args.aud, roster: args.roster, epoch: args.epoch, sealedBy: args.sealedBy, key, record: args.record, rotatorSignPub: rot?.s ?? null,
  });
  if (v.ok) return { ok: true, key, via: v.via };
  const identity = args.record && rot?.trust === 'unvouched' ? args.record.rotated_by : undefined;
  return identity ? { ok: false, reason: v.reason, identity } : { ok: false, reason: v.reason };
}

// ---------------------------------------------------------------------------------------------
// Signed member additions (roadmap 2026-11, batch 2). The server lists who should get an audience's key
// (pending_key_deliveries); a compromised server could add a member row of its own and have honest devices
// seal the key to it (the 2025 WhatsApp group analysis, ePrint 2025/794). So before sealing to a member of
// a list, group, event or conversation, a device checks cryptographic evidence that the member belongs:
//  - a signed addition (audience, member, added_by) by someone entitled to add them, or
//  - proof of earlier membership: a key delivery to them sealed and signed by a key authority (members
//    from before signed additions existed, and members whose adder has since left). The caller checks
//    that signature (crypto sealedSignatureValid) and passes `proven`.
// Nothing the server merely asserts (timestamps, roles of people who signed nothing) counts.

export interface MemberAddRow {
  audience_id: string; member_id: string; role: 'admin' | 'member'; status: string;
  add_by?: string | null; add_sig?: string | null; created_at: string;
}

/**
 * May I seal this audience's key to `row.member_id`? `verify(signerId, sig)` checks the addition signature
 * against the signer's TRUSTED identity key. Entitled adders, as the database's own rules allow: the owner
 * (the only one for lists); any active member, admins included (circle members invite friends, circle-event
 * guests invite circle members, conversation members add people they know); and the member themselves for
 * circles and events (open circles and circle events are joined directly).
 */
export function memberVouched(aud: AudienceMeta, roster: Roster, row: MemberAddRow, verify: (signerId: string, sig: string) => boolean, proven = false): boolean {
  if (aud.kind === 'friends' || aud.kind === 'self') return true;
  if (row.member_id === aud.owner_id) return true;
  if (proven) return true;
  const by = row.add_by;
  if (!by || !row.add_sig || !verify(by, row.add_sig)) return false;
  if (by === aud.owner_id) return true;
  if (aud.kind === 'list') return false;
  if (by === row.member_id) return aud.kind === 'group' || aud.kind === 'event';
  return roster.members.has(by);
}

/** Who may have sealed a key that proves earlier membership: a key authority, or (conversations) a member. */
export function provenBySealer(aud: AudienceMeta, roster: Roster, sealedBy: string, me: string): boolean {
  if (sealedBy === aud.owner_id || sealedBy === me || roster.admins.has(sealedBy)) return true;
  return aud.kind === 'conversation' && roster.members.has(sealedBy);
}
