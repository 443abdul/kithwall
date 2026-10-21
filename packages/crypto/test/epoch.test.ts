import { describe, expect, it } from 'vitest';
import { epochCommit, generateIdentity, keyMatchesCommit, newSymmetricKey, signEpochRecord, verifyEpochRecord } from '../src/index';
import { expectCode } from './helpers';

const AUD = '00000000-0000-0000-0000-0000000000aa';
const owner = generateIdentity();
const member = generateIdentity();

describe('epoch commitments (K1)', () => {
  it('binds the key, the audience and the epoch', () => {
    const k = newSymmetricKey();
    const c = epochCommit(AUD, 3, k);
    expect(c).toHaveLength(43);
    expect(keyMatchesCommit(AUD, 3, k, c)).toBe(true);
    expect(keyMatchesCommit(AUD, 4, k, c)).toBe(false);
    expect(keyMatchesCommit('00000000-0000-0000-0000-0000000000bb', 3, k, c)).toBe(false);
    expect(keyMatchesCommit(AUD, 3, newSymmetricKey(), c)).toBe(false);
    expect(keyMatchesCommit(AUD, 3, k, 'not a commit')).toBe(false);
  });
  it('validates inputs', () => {
    expectCode(() => epochCommit(AUD, 0, newSymmetricKey()), 'invalid_input');
    expectCode(() => epochCommit(AUD, 1.5, newSymmetricKey()), 'invalid_input');
    expectCode(() => epochCommit(AUD, 1, new Uint8Array(16)), 'invalid_input');
  });
});

describe('epoch records (K1)', () => {
  const k = newSymmetricKey();
  const rec = { audienceId: AUD, epoch: 2, rotatedBy: 'owner-id', commit: epochCommit(AUD, 2, k) };
  it('verify with the authority key only', () => {
    const sig = signEpochRecord(owner.signPriv, rec);
    expect(verifyEpochRecord(owner.signPub, rec, sig)).toBe(true);
    expect(verifyEpochRecord(member.signPub, rec, sig)).toBe(false);
  });
  it('a member cannot re-attribute or alter a record', () => {
    const sig = signEpochRecord(owner.signPriv, rec);
    expect(verifyEpochRecord(owner.signPub, { ...rec, epoch: 3 }, sig)).toBe(false);
    expect(verifyEpochRecord(owner.signPub, { ...rec, rotatedBy: 'member-id' }, sig)).toBe(false);
    expect(verifyEpochRecord(owner.signPub, { ...rec, commit: epochCommit(AUD, 2, newSymmetricKey()) }, sig)).toBe(false);
    // A record the member signed for its own planted key does not verify as the owner's.
    const planted = { ...rec, commit: epochCommit(AUD, 2, newSymmetricKey()) };
    expect(verifyEpochRecord(owner.signPub, planted, signEpochRecord(member.signPriv, planted))).toBe(false);
  });
  it('never throws on garbage', () => {
    expect(verifyEpochRecord(owner.signPub, { ...rec, commit: 'x' }, 'y')).toBe(false);
    expect(verifyEpochRecord(owner.signPub, null as never, 'y')).toBe(false);
  });
});
