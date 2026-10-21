// Donation config parsing: methods appear only for well-formed values. Run: npx vitest run src/lib/donate
import { describe, expect, it } from 'vitest';
import { isBitcoinAddress, isMoneroAddress, parseDonateConfig, safeHttpsUrl } from './donate';
import { cleanCommit, cleanRepoUrl, repoFileUrl, sourceUrl } from './source';

// Monero general-fund style address (95 chars, standard) and synthetic subaddress / integrated shapes.
const XMR = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge';
const XMR_SUB = `8${'A'.repeat(94)}`;
const XMR_INTEGRATED = `4${'B'.repeat(105)}`;
// BIP 173 / BIP 350 / BIP 86 vectors.
const P2WPKH = 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4';
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';

describe('address formats', () => {
  it('accepts Monero standard, sub- and integrated addresses', () => {
    expect(XMR).toHaveLength(95);
    expect(isMoneroAddress(XMR)).toBe(true);
    expect(isMoneroAddress(XMR_SUB)).toBe(true);
    expect(isMoneroAddress(XMR_INTEGRATED)).toBe(true);
  });
  it('rejects malformed Monero addresses', () => {
    expect(isMoneroAddress(XMR.slice(0, 94))).toBe(false);          // too short
    expect(isMoneroAddress(`5${XMR.slice(1)}`)).toBe(false);         // wrong network prefix
    expect(isMoneroAddress(`${XMR.slice(0, 94)}0`)).toBe(false);     // 0 isn't base58
    expect(isMoneroAddress(`8${'B'.repeat(105)}`)).toBe(false);      // integrated must start with 4
    expect(isMoneroAddress('')).toBe(false);
  });
  it('accepts bech32 / bech32m and legacy Bitcoin addresses', () => {
    expect(isBitcoinAddress(P2WPKH)).toBe(true);
    expect(isBitcoinAddress(P2WPKH.toLowerCase())).toBe(true);
    expect(isBitcoinAddress(P2WSH)).toBe(true);
    expect(isBitcoinAddress(P2TR)).toBe(true);
    expect(isBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(isBitcoinAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
  });
  it('rejects bad checksums, mixed case, other networks and junk', () => {
    expect(isBitcoinAddress(P2WPKH.toLowerCase().replace(/4$/, '5'))).toBe(false);
    expect(isBitcoinAddress(P2TR.replace('0xlx', '0xlz'))).toBe(false);
    expect(isBitcoinAddress('bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBe(false);   // mixed case
    expect(isBitcoinAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);    // testnet
    expect(isBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfN0')).toBe(false);           // 0 isn't base58
    expect(isBitcoinAddress('javascript:alert(1)')).toBe(false);
  });
  it('allows only plain https URLs with a real host', () => {
    expect(safeHttpsUrl('https://pay.example.org/apps/abc/pos')).toBe('https://pay.example.org/apps/abc/pos');
    expect(safeHttpsUrl('http://pay.example.org/')).toBeNull();
    expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpsUrl('https://user:pw@pay.example.org/')).toBeNull();
    expect(safeHttpsUrl('https://localhost/')).toBeNull();
    expect(safeHttpsUrl('not a url')).toBeNull();
  });
});

describe('parseDonateConfig', () => {
  it('shows nothing when nothing is set (launch state)', () => {
    expect(parseDonateConfig({})).toEqual([]);
    expect(parseDonateConfig({ monero: '', bitcoin: '  ', btcpayUrl: undefined, sponsorUrl: '' })).toEqual([]);
  });
  it('builds every method from valid values, trimmed, in display order', () => {
    const m = parseDonateConfig({
      monero: ` ${XMR} `, bitcoin: P2WPKH, btcpayUrl: 'https://pay.example.org/i/1', sponsorUrl: 'https://opencollective.example/kithwall',
    });
    expect(m.map((x) => x.kind)).toEqual(['monero', 'btcpay', 'bitcoin', 'sponsor']);
    expect(m[0]).toEqual({ kind: 'monero', address: XMR, uri: `monero:${XMR}` });
    expect(m[2]).toEqual({ kind: 'bitcoin', address: P2WPKH.toLowerCase(), uri: `bitcoin:${P2WPKH.toLowerCase()}` });
    expect(m[1]).toEqual({ kind: 'btcpay', url: 'https://pay.example.org/i/1' });
  });
  it('drops invalid values instead of showing them', () => {
    const m = parseDonateConfig({ monero: 'not-an-address', bitcoin: P2TR.slice(0, -1), btcpayUrl: 'http://pay.example.org', sponsorUrl: 'javascript:alert(1)' });
    expect(m).toEqual([]);
  });
});

describe('source links (AGPL §13)', () => {
  it('links to the exact commit when known', () => {
    expect(sourceUrl('https://github.com/443abdul/kithwall', 'abc1234def')).toBe('https://github.com/443abdul/kithwall/tree/abc1234def');
    expect(sourceUrl('https://github.com/443abdul/kithwall', null)).toBe('https://github.com/443abdul/kithwall');
    expect(repoFileUrl('/SECURITY.md', 'https://github.com/x/y', null)).toBe('https://github.com/x/y/blob/HEAD/SECURITY.md');
  });
  it('accepts only real commit hashes and clean https repo URLs', () => {
    expect(cleanCommit('ABC1234DEF')).toBe('abc1234def');
    expect(cleanCommit('main')).toBeNull();
    expect(cleanCommit('abc12')).toBeNull();
    expect(cleanCommit(undefined)).toBeNull();
    expect(cleanRepoUrl('https://github.com/me/fork/')).toBe('https://github.com/me/fork');
    expect(cleanRepoUrl('http://github.com/me/fork')).toBeNull();
    expect(cleanRepoUrl('https://github.com/me/fork?x=1')).toBeNull();
  });
});
