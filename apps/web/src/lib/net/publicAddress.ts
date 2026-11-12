import 'server-only';
// Which destinations a server-side fetch may reach (used by the link-preview proxy and by the automated
// accounts' feed reader). Anything a person can make the server fetch must go through these: only public
// internet addresses, also after DNS (every connection resolves through safeLookup) and after each redirect
// (the caller checks every hop with checkUrl).
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import net from 'node:net';

const deny4 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as [string, number][]) deny4.addSubnet(a, p, 'ipv4');

// IPv6: only global unicast (2000::/3) is allowed, minus special-purpose ranges. This also
// excludes ::1, ::, IPv4-mapped/-compatible (::ffff:0:0/96, ::/96), unique-local fc00::/7,
// link-local fe80::/10, multicast ff00::/8 and NAT64 64:ff9b::/96 (all outside 2000::/3).
const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const deny6 = new net.BlockList();
for (const [a, p] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as [string, number][]) deny6.addSubnet(a, p, 'ipv6');

export function isPublicAddress(address: string, family?: number): boolean {
  const fam = family ?? net.isIP(address);
  if (fam === 4) return net.isIPv4(address) && !deny4.check(address, 'ipv4');
  if (fam === 6) return net.isIPv6(address) && global6.check(address, 'ipv6') && !deny6.check(address, 'ipv6');
  return false;
}

export class BlockedError extends Error {}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup replacement used for every connection: refuses non-public destinations. */
export function safeLookup(hostname: string, options: { all?: boolean } | number | undefined, cb: LookupCb) {
  const all = typeof options === 'object' && options !== null && !!options.all;
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err, all ? [] : '', undefined);
    const list = addrs as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address, a.family))) {
      return cb(new BlockedError('blocked destination') as NodeJS.ErrnoException, all ? [] : '', undefined);
    }
    if (all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  });
}

export function checkUrl(raw: string, base?: URL): URL {
  let u: URL;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { throw new BlockedError('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedError('scheme');
  if (u.username || u.password) throw new BlockedError('credentials');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) {
    throw new BlockedError('port');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedError('host');
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedError('address');
  u.hash = '';
  return u;
}
