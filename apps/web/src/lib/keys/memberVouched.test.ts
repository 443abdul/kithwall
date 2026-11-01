import { describe, expect, it } from 'vitest';
import { memberVouched, provenBySealer, type AudienceMeta, type MemberAddRow, type Roster } from './authority';

const roster: Roster = { admins: new Set(['owner', 'admin']), members: new Set(['owner', 'admin', 'm1', 'm2']) };
const aud = (kind: AudienceMeta['kind']): AudienceMeta => ({ id: 'a', kind, owner_id: 'owner', current_epoch: 1 });
const row = (over: Partial<MemberAddRow>): MemberAddRow => ({ audience_id: 'a', member_id: 'x', role: 'member', status: 'active', created_at: '2020-01-01T00:00:00Z', ...over });
const good = (_by: string, sig: string) => sig === 'ok';

describe('memberVouched (signed member additions)', () => {
  it('accepts the owner, proven earlier members, and friends/self audiences', () => {
    expect(memberVouched(aud('group'), roster, row({ member_id: 'owner' }), good)).toBe(true);
    expect(memberVouched(aud('group'), roster, row({}), good, true)).toBe(true);
    expect(memberVouched(aud('friends'), roster, row({}), good)).toBe(true);
  });
  it('rejects rows nobody signed, forged signatures, and old timestamps alone (the server sets those)', () => {
    expect(memberVouched(aud('group'), roster, row({}), good)).toBe(false);
    expect(memberVouched(aud('group'), roster, row({ add_by: 'admin', add_sig: 'forged' }), good)).toBe(false);
    expect(memberVouched(aud('conversation'), roster, row({ created_at: '2000-01-01T00:00:00Z' }), good)).toBe(false);
  });
  it('lets any current member add to circles, events and conversations; only the owner to lists', () => {
    expect(memberVouched(aud('group'), roster, row({ add_by: 'm1', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('event'), roster, row({ add_by: 'm2', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('conversation'), roster, row({ add_by: 'outsider', add_sig: 'ok' }), good)).toBe(false);
    expect(memberVouched(aud('list'), roster, row({ add_by: 'm1', add_sig: 'ok' }), good)).toBe(false);
    expect(memberVouched(aud('list'), roster, row({ add_by: 'owner', add_sig: 'ok' }), good)).toBe(true);
  });
  it('accepts joining by yourself for circles and events only', () => {
    expect(memberVouched(aud('event'), roster, row({ add_by: 'x', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('group'), roster, row({ add_by: 'x', add_sig: 'ok' }), good)).toBe(true);
    expect(memberVouched(aud('conversation'), roster, row({ add_by: 'x', add_sig: 'ok' }), good)).toBe(false);
  });
  it('only key authorities (or conversation members) can prove earlier membership', () => {
    expect(provenBySealer(aud('group'), roster, 'admin', 'me')).toBe(true);
    expect(provenBySealer(aud('group'), roster, 'm1', 'me')).toBe(false);
    expect(provenBySealer(aud('conversation'), roster, 'm1', 'me')).toBe(true);
    expect(provenBySealer(aud('list'), roster, 'me', 'me')).toBe(true);
  });
});
