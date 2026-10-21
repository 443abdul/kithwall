// UnifiedPush endpoints are arbitrary URLs chosen by the device's distributor (ntfy, NextPush, a
// self-hosted server…), so the dispatch route must never be usable to reach anything else (SSRF):
//   - https only, default port, no credentials, a real DNS name (no IP literals, no single-label or
//     local/internal names), at most 1024 characters;
//   - at send time every address the name resolves to must be public (checked inside the socket's own
//     DNS lookup, so a rebinding answer can't slip in between the check and the connect);
//   - no redirects are followed, the body is small (≤ 4 KiB) and the request times out (native-server.ts).
// Pure node: unit-tested in push.test.ts.
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

const MAX_LEN = 1024;
const BAD_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.home.arpa', '.onion', '.invalid', '.test', '.example'];

// Two lists: Node's BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules, so the
// ::ffff:0:0/96 rule must not share a list with the IPv4 checks.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(net, bits, 'ipv6');

/** Is this IP address publicly routable (not loopback, private, link-local, CGNAT, multicast, …)? */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !blocked4.check(ip, 'ipv4');
  if (v === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / -compatible / NAT64 forms are never needed for a push server: refuse them outright.
    if (/^::(?:ffff:)?\d+\.\d+\.\d+\.\d+$/.test(lower) || lower.startsWith('::ffff:')) return false;
    return !blocked6.check(lower, 'ipv6');
  }
  return false;
}

/** Shape check for a UnifiedPush endpoint before it is stored or used. */
export function isUnifiedPushEndpoint(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > MAX_LEN || /[\s\\]/.test(u)) return false;
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) || host.startsWith('[')) return false;
  if (!host.includes('.') || host === 'localhost') return false;
  if (BAD_SUFFIXES.some((s) => host.endsWith(s))) return false;
  if (!/^[a-z0-9.-]+$/.test(host)) return false;   // punycode only, no odd characters
  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
type Resolver = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void) => void;

const systemResolver: Resolver = (host, cb) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => cb(err, addrs ?? []));

/**
 * A `lookup` for http(s).request that refuses names resolving to any non-public address. Use it on the
 * request itself so the address that is checked is the address that is connected to.
 */
export function publicOnlyLookup(resolve: Resolver = systemResolver) {
  return (host: string, options: { all?: boolean } | number | undefined, cb: LookupCb) => {
    resolve(host, (err, addrs) => {
      if (err) return cb(err, '');
      if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) {
        const e = new Error(`refusing to connect to a non-public address for ${host}`) as NodeJS.ErrnoException;
        e.code = 'EKW_PRIVATE_ADDRESS';
        return cb(e, '');
      }
      if (typeof options === 'object' && options?.all) return cb(null, addrs);
      return cb(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}
