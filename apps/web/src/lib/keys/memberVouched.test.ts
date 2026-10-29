import { describe, expect, it } from 'vitest';
import { memberVouched, MEMBER_SIG_CUTOFF, type AudienceMeta, type MemberAddRow, type Roster } from './authority';

const NEW = '2027-01-01T00:00:00Z';
const OLD = '2026-01-01T00:00:00Z';
const roster: Roster = { admins: new Set(['owner', 'admin']), members: new Set(['owner', 'admin', 'm1', 'm2']) };
const aud = (kind: AudienceMeta['kind']): AudienceMeta => ({ id: 'a', kind, owner_id: 'owner', current_epoch: 1 });
const row = (over: Partial<MemberAddRow>): MemberAddRow => ({ audience_id: 'a', member_id: 'x', role: 'member', status: 'active', created_at: NEW, ...over });
const good = (_by: string, sig: string) => sig === 'ok';

describe('memberVouched (signed member additions)', () => {
  it('accepts the owner, legacy rows and friends/self audiences without a signature', () => {
    expect(memberVouched(aud('group'), roster, row({ member_id: 'owner' }), good)).toBe(true);
    expect(memberVouched(aud('group'), roster, row({ created_at: OLD }), good)).toBe(true);
    expect(OLD < MEMBER_SIG_CUTOFF && NEW > MEMBER_SIG_CUTOFF).toBe(true);
    expect(memberVouched(aud('friends'), roster, row({}), good)).toBe(true);
  });
  it('rejects a new member row nobody signed, or a forged signature (server-inserted members)', () => {
    expect(memberVouched(aud('group'), roster, row({}), good)).toBe(false);
    expect(memberVouched(aud('group'), roster, row({ add_by: 'admin', add_sig: 'forged' }), good)).toBe(false);
  });
  it('lets admins add to circles and events, members add to conversations, only the owner add to lists', () => {
    expect(memberVouched(aud('group'), roster, row({ add_by: 'admin', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('group'), roster, row({ add_by: 'm1', add_sig: 'ok' }), good)).toBe(false);
    expect(memberVouched(aud('conversation'), roster, row({ add_by: 'm1', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('conversation'), roster, row({ add_by: 'outsider', add_sig: 'ok' }), good)).toBe(false);
    expect(memberVouched(aud('list'), roster, row({ add_by: 'admin', add_sig: 'ok' }), good)).toBe(false);
    expect(memberVouched(aud('list'), roster, row({ add_by: 'owner', add_sig: 'ok' }), good)).toBe(true);
  });
  it('accepts joining by yourself only for events (circle events)', () => {
    expect(memberVouched(aud('event'), roster, row({ add_by: 'x', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('group'), roster, row({ add_by: 'x', add_sig: 'ok' }), good)).toBe(false);
  });
});
