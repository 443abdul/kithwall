// Client IP buckets for unauthenticated rate limits (security re-review R-W4). Pure: unit-tested in Node.
/**
 * The unit a client is counted by (security re-review R-W4): an IPv4 address, or the /64 network of an
 * IPv6 address (one subscriber usually holds a whole /64, so per-address tags let one person act as
 * billions of requesters). IPv4-mapped IPv6 addresses count as their IPv4 address.
 */
export function ipBucket(ip: string): string {
  const raw = ip.trim().replace(/^\[|\](:\d+)?$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!raw.includes(':')) return raw;
  const mapped = /^[0:]*:ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1]!;
  let parts: string[];
  if (raw.includes('::')) {
    const [head = '', tail = ''] = raw.split('::', 2);
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    if (t.length && t[t.length - 1]!.includes('.')) t.splice(t.length - 1, 1, '0', '0');
    parts = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    parts = raw.split(':');
  }
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return raw;
  return `${parts.slice(0, 4).map((x) => x.padStart(4, '0')).join(':')}::/64`;
}
