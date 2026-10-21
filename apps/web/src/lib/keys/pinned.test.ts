// Run: npx vitest run src/lib/keys
// Security re-review R-K-1 / R-K-2 (docs/v2/06-security-review.md §10.2), client rules with real crypto.
//
// R-K-1: the operator (or someone with the database) swaps a group admin's published sign_pub for a key it
// holds, advances the epoch with a record signed by that key and seals the new epoch key "from" the admin.
// Before the fix, members verified seals and records against the PUBLISHED key and adopted the operator's
// key. Now they verify against the identity key they pinned (pinsCore.trustedKeysFor + authority.judgeIncoming).
// The same attack end to end against the local database: keyswap.e2e.test.ts.
import { describe, expect, it } from 'vitest';
import {
  b64u, epochCommit, generateIdentity, newSymmetricKey, openSealed, seal, signAdminGrant, signEpochRecord, signKeyChange,
  type KeyChange, type Sealed,
} from '@kithwall/crypto';
import { judgeIncoming, verifiedAdmins, type AudienceMeta, type EpochRecordRow, type Roster, type TrustedSigner } from './authority';
import { trustedKeysFor, type KeyChangeLogRow, type Pin } from './pinsCore';

const AUD = '80000000-0000-0000-0000-0000000000e1';
const OWNER = 'owner-0000';
const ADMIN = 'admin-0000';
const MEMBER = 'member-000';
const ghost = 'ghost-0000';
const ids = { [OWNER]: generateIdentity(), [ADMIN]: generateIdentity(), [MEMBER]: generateIdentity(), [ghost]: generateIdentity() };
const operator = generateIdentity();       // the key the operator puts into the admin's profile
const enc = (i: ReturnType<typeof generateIdentity>) => ({ s: b64u.encode(i.signPub), x: b64u.encode(i.kxPub) });
const ctx = (epoch: number, recipient: string) => `audience-key/${AUD}/${epoch}/${recipient}`;
const group = (epoch: number): AudienceMeta => ({ id: AUD, kind: 'group', owner_id: OWNER, current_epoch: epoch });
const grant = (member: string, by: string, signer = ids[by as keyof typeof ids]) =>
  ({ member_id: member, role: 'admin', grant_by: by, grant_sig: signAdminGrant(signer.signPriv, { audienceId: AUD, memberId: member, grantedBy: by }) });

function record(by: string, epoch: number, key: Uint8Array, signPriv: Uint8Array): EpochRecordRow {
  const commit = epochCommit(AUD, epoch, key);
  return { audience_id: AUD, epoch, rotated_by: by, commit, sig: signEpochRecord(signPriv, { audienceId: AUD, epoch, rotatedBy: by, commit }) };
}
/** What the member's device does with one delivery, given who it trusts how. */
function receive(args: { sealed: Sealed; epoch: number; sealedBy: string; record: EpochRecordRow | null; roster: Roster; signer: (id: string) => TrustedSigner | null }) {
  const me = ids[MEMBER];
  return judgeIncoming({
    aud: group(args.epoch), roster: args.roster, epoch: args.epoch, sealedBy: args.sealedBy, record: args.record, signer: args.signer,
    open: (pub) => {
      try { return openSealed({ sealed: args.sealed, recipientKxPriv: me.kxPriv, recipientKxPub: me.kxPub, senderSignPub: b64u.decode(pub), context: ctx(args.epoch, MEMBER) }); }
      catch { return null; }
    },
  });
}

describe('R-K-1: keys are verified against pinned identity keys', () => {
  const roster: Roster = { admins: new Set([ADMIN]), members: new Set([OWNER, ADMIN, MEMBER]) };
  const adminPin: Pin = { ...enc(ids[ADMIN]), at: '2026-10-01T00:00:00.000Z' };
  // The operator's attack: published key swapped, epoch 2 recorded and sealed with the operator's key.
  const evilKey = newSymmetricKey();
  const evilRecord = record(ADMIN, 2, evilKey, operator.signPriv);
  const evilSealed = seal({ recipientKxPub: ids[MEMBER].kxPub, senderSignPriv: operator.signPriv, context: ctx(2, MEMBER), plaintext: evilKey });

  it('reproduces the attack: trusting the PUBLISHED key adopts the operator\'s epoch key (the old behaviour)', () => {
    const published = (id: string): TrustedSigner | null => (id === ADMIN ? { s: b64u.encode(operator.signPub), trust: 'pinned' } : { s: enc(ids[id as keyof typeof ids]).s, trust: 'pinned' });
    const res = receive({ sealed: evilSealed, epoch: 2, sealedBy: ADMIN, record: evilRecord, roster, signer: published });
    expect(res.ok).toBe(true);   // this is what the re-review demonstrated
  });

  it('with the pin, the swapped key is "unvouched": the key is NOT adopted and a safety-number warning is raised', () => {
    const t = trustedKeysFor(adminPin, enc(operator), []);          // no signed key change from the pinned key
    expect(t.trust).toBe('unvouched');
    expect(t.s).toBe(adminPin.s);                                     // keep verifying with the pinned key
    const signer = (id: string): TrustedSigner | null => (id === ADMIN ? { s: t.s, trust: t.trust } : { s: enc(ids[id as keyof typeof ids]).s, trust: 'pinned' });
    const res = receive({ sealed: evilSealed, epoch: 2, sealedBy: ADMIN, record: evilRecord, roster, signer });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'wait', identity: ADMIN });
  });

  it('an honest member relaying the operator\'s key is refused: the record does not verify against the pin', () => {
    const t = trustedKeysFor(adminPin, enc(operator), []);
    const signer = (id: string): TrustedSigner | null => (id === ADMIN ? { s: t.s, trust: t.trust } : { s: enc(ids[id as keyof typeof ids]).s, trust: 'pinned' });
    const plainMember = 'member-002';
    const relayer = generateIdentity();
    const sealedByRelayer = seal({ recipientKxPub: ids[MEMBER].kxPub, senderSignPriv: relayer.signPriv, context: ctx(2, MEMBER), plaintext: evilKey });
    const res = judgeIncoming({
      aud: { ...group(2), kind: 'conversation' }, roster: { admins: new Set([ADMIN]), members: new Set([OWNER, ADMIN, MEMBER, plainMember]) },
      epoch: 2, sealedBy: plainMember, record: evilRecord,
      signer: (id) => (id === plainMember ? { s: b64u.encode(relayer.signPub), trust: 'pinned' } : signer(id)),
      open: (pub) => { try { return openSealed({ sealed: sealedByRelayer, recipientKxPriv: ids[MEMBER].kxPriv, recipientKxPub: ids[MEMBER].kxPub, senderSignPub: b64u.decode(pub), context: ctx(2, MEMBER) }); } catch { return null; } },
    });
    expect(res).toEqual({ ok: false, reason: 'wait', identity: ADMIN });
  });

  it('a genuine rotation signed by the pinned key is trusted (vouched) and its keys are adopted', () => {
    const next = generateIdentity();
    const at = '2026-10-20T00:00:00.000Z';
    const c: KeyChange = { userId: ADMIN, newSignPub: enc(next).s, newKxPub: enc(next).x, at };
    const log: KeyChangeLogRow[] = [{ change: c, sig: signKeyChange(ids[ADMIN].signPriv, c), created_at: at }];
    const t = trustedKeysFor(adminPin, enc(next), log);
    expect(t).toEqual({ ...enc(next), trust: 'vouched' });
    const key = newSymmetricKey();
    const rec = record(ADMIN, 3, key, next.signPriv);
    const sealed = seal({ recipientKxPub: ids[MEMBER].kxPub, senderSignPriv: next.signPriv, context: ctx(3, MEMBER), plaintext: key });
    const signer = (id: string): TrustedSigner | null => (id === ADMIN ? { s: t.s, trust: t.trust } : { s: enc(ids[id as keyof typeof ids]).s, trust: 'pinned' });
    expect(receive({ sealed, epoch: 3, sealedBy: ADMIN, record: rec, roster, signer })).toMatchObject({ ok: true, via: 'record' });
  });

  it('first sight (no pin) is trust on first use: published keys are used', () => {
    expect(trustedKeysFor(undefined, enc(operator), null)).toEqual({ ...enc(operator), trust: 'new' });
  });

  it('a forged post-style signature check: content signed by the swapped key fails against the pinned key', () => {
    // people.get(id).sign_pub is the trusted key; any verification using it rejects the operator's signature.
    const t = trustedKeysFor(adminPin, enc(operator), []);
    expect(t.s).not.toBe(enc(operator).s);
  });
});

describe('R-K-2: admins need a signed grant chain back to the owner', () => {
  const pubOf = (id: string) => enc(ids[id as keyof typeof ids]).s;
  it('the owner\'s grant makes an admin; a server-made admin (no grant) is not one', () => {
    const rows = [grant(ADMIN, OWNER), { member_id: ghost, role: 'admin', grant_by: null, grant_sig: null }, { member_id: MEMBER, role: 'member' }];
    expect([...verifiedAdmins({ id: AUD, owner_id: OWNER }, rows, pubOf)]).toEqual([ADMIN]);
  });
  it('chains through admins, but not through someone who is not an admin', () => {
    const rows = [grant(ADMIN, OWNER), grant(MEMBER, ADMIN), grant(ghost, 'nobody', ids[ghost])];
    expect([...verifiedAdmins({ id: AUD, owner_id: OWNER }, rows, pubOf)].sort()).toEqual([ADMIN, MEMBER].sort());
  });
  it('a grant signed with a key the operator swapped in is rejected (verified against the pinned key)', () => {
    const forged = grant(ghost, OWNER, operator);   // the operator signs "owner made ghost an admin"
    expect(verifiedAdmins({ id: AUD, owner_id: OWNER }, [forged], pubOf).size).toBe(0);
  });
  it('a grant is bound to its audience and member', () => {
    const g = grant(ADMIN, OWNER);
    expect(verifiedAdmins({ id: '80000000-0000-0000-0000-0000000000e2', owner_id: OWNER }, [g], pubOf).size).toBe(0);
    expect(verifiedAdmins({ id: AUD, owner_id: OWNER }, [{ ...g, member_id: ghost }], pubOf).size).toBe(0);
  });
});
