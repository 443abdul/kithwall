// Donation methods for /donate. None are configured yet (docs/v2/00-brief.md §9): each method appears only
// when its NEXT_PUBLIC_DONATE_* variable is set at build time AND passes the format check below, so a
// typo can never show a broken or wrong address. See docs/deploy.md ("Donations").
//
// Addresses are only format-checked (alphabet, prefix, length; bech32/bech32m checksum for bc1…). Whoever
// sets them must still double-check the value against their wallet.

export type DonateMethod =
  | { kind: 'monero'; address: string; uri: string }
  | { kind: 'bitcoin'; address: string; uri: string }
  | { kind: 'btcpay'; url: string }
  | { kind: 'sponsor'; url: string };

export interface DonateEnv {
  monero?: string;
  bitcoin?: string;
  btcpayUrl?: string;
  sponsorUrl?: string;
}

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

/** Monero: standard (4…) or subaddress (8…) 95 chars, integrated (4…) 106 chars, base58. */
export function isMoneroAddress(s: string): boolean {
  return new RegExp(`^[48]${BASE58}{94}$`).test(s) || new RegExp(`^4${BASE58}{105}$`).test(s);
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]!;
  }
  return chk >>> 0;
}

/** bc1… segwit address with a valid bech32 (v0) or bech32m (v1+) checksum (BIP 173 / BIP 350). */
export function isBech32Bitcoin(s: string): boolean {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return false;
  const a = s.toLowerCase();
  if (!/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8,87}$/.test(a) || a.length > 90) return false;
  const data = [...a.slice(3)].map((c) => BECH32.indexOf(c));
  const hrp = [...'bc'].map((c) => c.charCodeAt(0));
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)];
  const witnessVersion = data[0]!;
  if (witnessVersion > 16) return false;
  const constant = witnessVersion === 0 ? 1 : 0x2bc830a3;
  if (polymod([...expanded, ...data]) !== constant) return false;
  // Witness program length (5-bit groups → bytes): v0 is 20 or 32 bytes, others 2–40.
  const bytes = Math.floor(((data.length - 7) * 5) / 8);
  return witnessVersion === 0 ? bytes === 20 || bytes === 32 : bytes >= 2 && bytes <= 40;
}

/** Bitcoin mainnet: bech32 bc1…, or legacy base58 P2PKH (1…) / P2SH (3…). */
export function isBitcoinAddress(s: string): boolean {
  if (/^bc1/i.test(s)) return isBech32Bitcoin(s);
  return new RegExp(`^[13]${BASE58}{25,34}$`).test(s);
}

/** An https URL with a real host and no credentials; returned normalised, else null. */
export function safeHttpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!u.hostname.includes('.') || u.hostname.endsWith('.')) return null;
    return u.href;
  } catch { return null; }
}

/** Parse the configured methods (pure; unit-tested). Invalid or empty values are skipped. */
export function parseDonateConfig(env: DonateEnv): DonateMethod[] {
  const out: DonateMethod[] = [];
  const v = (x: string | undefined) => (x ?? '').trim();
  const xmr = v(env.monero);
  if (xmr && isMoneroAddress(xmr)) out.push({ kind: 'monero', address: xmr, uri: `monero:${xmr}` });
  const btcpay = v(env.btcpayUrl) && safeHttpsUrl(v(env.btcpayUrl));
  if (btcpay) out.push({ kind: 'btcpay', url: btcpay });
  const btc = v(env.bitcoin);
  if (btc && isBitcoinAddress(btc)) {
    // bech32 is case-insensitive (BIP 173); show and encode the usual lowercase form.
    const addr = /^bc1/i.test(btc) ? btc.toLowerCase() : btc;
    out.push({ kind: 'bitcoin', address: addr, uri: `bitcoin:${addr}` });
  }
  const sponsor = v(env.sponsorUrl) && safeHttpsUrl(v(env.sponsorUrl));
  if (sponsor) out.push({ kind: 'sponsor', url: sponsor });
  return out;
}

// Each variable is referenced literally so Next.js inlines it at build time.
export const DONATE_METHODS: DonateMethod[] = parseDonateConfig({
  monero: process.env.NEXT_PUBLIC_DONATE_MONERO,
  bitcoin: process.env.NEXT_PUBLIC_DONATE_BITCOIN,
  btcpayUrl: process.env.NEXT_PUBLIC_DONATE_BTCPAY_URL,
  sponsorUrl: process.env.NEXT_PUBLIC_DONATE_SPONSOR_URL,
});
