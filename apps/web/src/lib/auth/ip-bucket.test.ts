// Run: npx vitest run src/lib/auth/ip-bucket.test.ts
// Security re-review R-W4 / final review NEW-2: recovery limits counted every IPv6 address separately, so one
// subscriber's prefix was billions of "requesters". Clients are now counted per IPv4 address or per IPv6 /48.
import { describe, expect, it } from 'vitest';
import { ipBucket } from './ip-bucket';

describe('ipBucket (R-W4, NEW-2)', () => {
  it('one /48 is one requester, however the address is written', () => {
    const a = ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:0db8:0001::/48');
    expect(ipBucket('2001:db8:1:2::1')).toBe(a);
    expect(ipBucket('2001:DB8:1:2:ffff::')).toBe(a);
    expect(ipBucket('[2001:db8:1:2::9]:443')).toBe(a);
    expect(ipBucket('2001:db8:1:2::1%eth0')).toBe(a);
  });
  it('every /64 inside one /48 is the same requester', () => {
    expect(ipBucket('2001:db8:1:3::1')).toBe(ipBucket('2001:db8:1:2::1'));
    expect(ipBucket('2001:db8:1:ffff::1')).toBe(ipBucket('2001:db8:1:0::1'));
  });
  it('different /48s stay different', () => {
    expect(ipBucket('2001:db8:2::1')).not.toBe(ipBucket('2001:db8:1::1'));
    expect(ipBucket('::1')).toBe('0000:0000:0000::/48');
  });
  it('IPv4 (also IPv4-mapped) is counted per address', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('203.0.113.8')).not.toBe(ipBucket('203.0.113.7'));
  });
  it('leaves anything unparseable as it is (still a distinct, deterministic tag)', () => {
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('1:2:3')).toBe('1:2:3');
  });
});
