// Punycode (RFC 3492) decoding for IDN labels ("xn--…"), so the "Leaving Kithwall" sheet can show what a
// hostname really spells. Browsers only expose the ASCII form (URL.hostname); there is no built-in decoder.
// Pure, no dependencies; unit-tested in analyze.test.ts.

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) { d = Math.floor(d / (BASE - TMIN)); k += BASE; }
  return Math.floor(k + ((BASE - TMIN + 1) * d) / (d + SKEW));
}

function digit(cp: number): number {
  if (cp >= 0x30 && cp <= 0x39) return cp - 22; // 0-9 → 26-35
  if (cp >= 0x41 && cp <= 0x5a) return cp - 0x41; // A-Z
  if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61; // a-z
  return BASE;
}

/** Decode one Punycode label body (without "xn--"). Returns null when it is malformed. */
export function decodeLabel(input: string): string | null {
  const out: number[] = [];
  const b = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(b, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const d = digit(input.charCodeAt(idx++));
      if (d >= BASE) return null;
      i += d * w;
      if (i > 0x7fffffff) return null;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

/** "xn--pple-43d.com" → "аpple.com". Labels that aren't Punycode are kept as they are. */
export function toUnicode(host: string): string {
  return host.split('.').map((l) => {
    if (!/^xn--/i.test(l)) return l;
    return decodeLabel(l.slice(4).toLowerCase()) ?? l;
  }).join('.');
}
