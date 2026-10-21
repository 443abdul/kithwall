// Run: npx vitest run src/lib/keys
// Security review K1: which audience keys a client adopts. Each test replays an attack from the review
// against the client-side rule (the database refuses the same rows: supabase/tests/keys.test.sql).
import { describe, expect, it } from 'vitest';
import { b64u, epochCommit, generateIdentity, newSymmetricKey, signEpochRecord } from '@kithwall/crypto';
import { judgeKey, isKeyAuthority, type AudienceMeta, type EpochRecordRow, type Roster } from './authority';

const OWNER = 'owner-0000';
const MALLORY = 'mallory-00';
const BOB = 'bob-000000';
const ADMIN = 'admin-0000';
const AUD = '80000000-0000-0000-0000-0000000000c1';
const ids = { [OWNER]: generateIdentity(), [MALLORY]: generateIdentity(), [BOB]: generateIdentity(), [ADMIN]: generateIdentity() };
const pub = (u: string) => b64u.encode(ids[u as keyof typeof ids].signPub);

function record(by: string, epoch: number, key: Uint8Array, aud = AUD): EpochRecordRow {
  const commit = epochCommit(aud, epoch, key);
  return { audience_id: aud, epoch, rotated_by: by, commit, sig: signEpochRecord(ids[by as keyof typeof ids].signPriv, { audienceId: aud, epoch, rotatedBy: by, commit }) };
}
const chat = (epoch: number): AudienceMeta => ({ id: AUD, kind: 'conversation', owner_id: OWNER, current_epoch: epoch });
const roster = (members: string[], admins: string[] = [OWNER]): Roster => ({ admins: new Set(admins), members: new Set([...members, ...admins]) });

describe('judgeKey (K1)', () => {
  it('rejects the review exploit: a key planted by a member for a future epoch is not adopted after the rotation', () => {
    const planted = newSymmetricKey();
    // Mallory plants epoch 2 while the chat is at epoch 1: refused outright (no future epochs).
    expect(judgeKey({ aud: chat(1), roster: roster([MALLORY, BOB]), epoch: 2, sealedBy: MALLORY, key: planted, record: null, rotatorSignPub: null }))
      .toEqual({ ok: false, reason: 'conflict' });
    // The owner removes Mallory and rotates: epoch 2 now has the owner's signed record. Mallory's planted
    // key (or a relay of it by anyone) contradicts the record → conflict, never adopted.
    const real = newSymmetricKey();
    const rec = record(OWNER, 2, real);
    expect(judgeKey({ aud: chat(2), roster: roster([BOB]), epoch: 2, sealedBy: MALLORY, key: planted, record: rec, rotatorSignPub: pub(OWNER) }))
      .toEqual({ ok: false, reason: 'conflict' });
    expect(judgeKey({ aud: chat(2), roster: roster([BOB]), epoch: 2, sealedBy: BOB, key: planted, record: rec, rotatorSignPub: pub(OWNER) }))
      .toEqual({ ok: false, reason: 'conflict' });
    // The owner's key is adopted, whoever relays it.
    expect(judgeKey({ aud: chat(2), roster: roster([BOB]), epoch: 2, sealedBy: OWNER, key: real, record: rec, rotatorSignPub: pub(OWNER) }))
      .toEqual({ ok: true, via: 'record' });
    expect(judgeKey({ aud: chat(2), roster: roster([BOB]), epoch: 2, sealedBy: BOB, key: real, record: rec, rotatorSignPub: pub(OWNER) }))
      .toEqual({ ok: true, via: 'record' });
  });

  it('does not take "first valid signature wins": a non-authority key for an unrecorded current epoch waits', () => {
    expect(judgeKey({ aud: chat(3), roster: roster([MALLORY]), epoch: 3, sealedBy: MALLORY, key: newSymmetricKey(), record: null, rotatorSignPub: null }))
      .toEqual({ ok: false, reason: 'wait' });
    expect(judgeKey({ aud: chat(3), roster: roster([MALLORY]), epoch: 3, sealedBy: OWNER, key: newSymmetricKey(), record: null, rotatorSignPub: null }))
      .toEqual({ ok: true, via: 'authority' });
  });

  it('ignores a record forged by a member (signed by the wrong key or by a non-authority)', () => {
    const key = newSymmetricKey();
    const forged = record(MALLORY, 2, key);
    // Mallory signs a record naming herself: she isn't an authority for the current epoch.
    expect(judgeKey({ aud: chat(2), roster: roster([MALLORY]), epoch: 2, sealedBy: MALLORY, key, record: forged, rotatorSignPub: pub(MALLORY) }))
      .toEqual({ ok: false, reason: 'wait' });
    // Mallory's signature on a record naming the owner doesn't verify against the owner's key.
    const fake = { ...forged, rotated_by: OWNER };
    expect(judgeKey({ aud: chat(2), roster: roster([MALLORY]), epoch: 2, sealedBy: MALLORY, key, record: fake, rotatorSignPub: pub(OWNER) }))
      .toEqual({ ok: false, reason: 'wait' });
  });

  it('a removed member cannot be the source of keys for the epoch after their removal', () => {
    // After rotation Mallory is no longer in the roster; a key she sealed (e.g. pre-planted) for the
    // current epoch without a record is not adopted.
    expect(judgeKey({ aud: chat(4), roster: roster([BOB]), epoch: 4, sealedBy: MALLORY, key: newSymmetricKey(), record: null, rotatorSignPub: null }))
      .toEqual({ ok: false, reason: 'wait' });
  });

  it('friends / self / list audiences: only their owner, never an admin or a friend', () => {
    const friends: AudienceMeta = { id: AUD, kind: 'friends', owner_id: OWNER, current_epoch: 1 };
    expect(judgeKey({ aud: friends, roster: roster([], [ADMIN]), epoch: 1, sealedBy: ADMIN, key: newSymmetricKey(), record: null, rotatorSignPub: null }).ok).toBe(false);
    expect(judgeKey({ aud: friends, roster: roster([]), epoch: 1, sealedBy: MALLORY, key: newSymmetricKey(), record: null, rotatorSignPub: null }).ok).toBe(false);
    expect(judgeKey({ aud: friends, roster: roster([]), epoch: 1, sealedBy: OWNER, key: newSymmetricKey(), record: null, rotatorSignPub: null }).ok).toBe(true);
    expect(isKeyAuthority({ ...friends, kind: 'list' }, roster([], [ADMIN]), ADMIN)).toBe(false);
  });

  it('groups: an active admin is an authority; a plain member is not', () => {
    const group: AudienceMeta = { id: AUD, kind: 'group', owner_id: OWNER, current_epoch: 5 };
    expect(judgeKey({ aud: group, roster: roster([MALLORY], [OWNER, ADMIN]), epoch: 3, sealedBy: ADMIN, key: newSymmetricKey(), record: null, rotatorSignPub: null }).ok).toBe(true);
    expect(judgeKey({ aud: group, roster: roster([MALLORY], [OWNER, ADMIN]), epoch: 3, sealedBy: MALLORY, key: newSymmetricKey(), record: null, rotatorSignPub: null }).ok).toBe(false);
  });

  it('conflicting keys for the same epoch: only the one matching the record is adopted', () => {
    const a = newSymmetricKey();
    const b = newSymmetricKey();
    const rec = record(ADMIN, 5, a);
    const group: AudienceMeta = { id: AUD, kind: 'group', owner_id: OWNER, current_epoch: 5 };
    const r = roster([], [OWNER, ADMIN]);
    expect(judgeKey({ aud: group, roster: r, epoch: 5, sealedBy: ADMIN, key: a, record: rec, rotatorSignPub: pub(ADMIN) }).ok).toBe(true);
    // Even the owner can't override another admin's recorded key with a second one for that epoch.
    expect(judgeKey({ aud: group, roster: r, epoch: 5, sealedBy: OWNER, key: b, record: rec, rotatorSignPub: pub(ADMIN) }))
      .toEqual({ ok: false, reason: 'conflict' });
  });

  it('keeps old history readable: past chat epochs relayed by a current member, and records by people who left', () => {
    const key = newSymmetricKey();
    expect(judgeKey({ aud: chat(6), roster: roster([BOB]), epoch: 2, sealedBy: BOB, key, record: null, rotatorSignPub: null }))
      .toEqual({ ok: true, via: 'history' });
    const rec = record(ADMIN, 3, key);  // ADMIN minted epoch 3 and has since left
    expect(judgeKey({ aud: chat(6), roster: roster([BOB]), epoch: 3, sealedBy: BOB, key, record: rec, rotatorSignPub: pub(ADMIN) }))
      .toEqual({ ok: true, via: 'record' });
  });

  it('waits when the audience is not visible', () => {
    expect(judgeKey({ aud: null, roster: roster([]), epoch: 1, sealedBy: OWNER, key: newSymmetricKey(), record: null, rotatorSignPub: null }))
      .toEqual({ ok: false, reason: 'wait' });
  });
});
