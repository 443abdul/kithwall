// Run: npx vitest run src/lib/qr.test.ts
// Checks the encoder against values from ISO/IEC 18004 and decodes its own output with an independent
// reader (format info → unmask → zigzag read → de-interleave → Reed–Solomon check → byte-mode payload).
import { describe, expect, it } from 'vitest';
import { alignmentPositions, codewords, dataCodewords, encodeQr, formatBits, gfMul, qrPath, rawDataModules, rsDivisor, rsRemainder, versionBits, type Ecc, type QrCode } from './qr';

describe('Reed–Solomon', () => {
  it('matches the ISO 18004 example "01234567" (version 1-M)', () => {
    const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
  });
  it('multiplies in GF(256)', () => {
    expect(gfMul(0, 7)).toBe(0);
    expect(gfMul(1, 0x53)).toBe(0x53);
    expect(gfMul(2, 0x80)).toBe(0x1d);
  });
});

describe('tables', () => {
  it('has the standard capacities', () => {
    expect(dataCodewords(1, 'L')).toBe(19);
    expect(dataCodewords(1, 'M')).toBe(16);
    expect(dataCodewords(1, 'Q')).toBe(13);
    expect(dataCodewords(1, 'H')).toBe(9);
    expect(dataCodewords(10, 'M')).toBe(216);
    expect(dataCodewords(40, 'L')).toBe(2956);
    expect(dataCodewords(40, 'H')).toBe(1276);
    expect(rawDataModules(1)).toBe(208);
  });
  it('has the standard format and version information', () => {
    expect(formatBits('M', 0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits('L', 0).toString(2).padStart(15, '0')).toBe('111011111000100');
    expect(formatBits('H', 7).toString(2).padStart(15, '0')).toBe('000100000111011');
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
  });
  it('places alignment patterns', () => {
    expect(alignmentPositions(1)).toEqual([]);
    expect(alignmentPositions(2)).toEqual([6, 18]);
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
  });
});

// ------------------------------------------------------------------------- independent reader

function readFormat(q: QrCode): { ecc: Ecc; mask: number } {
  let bits = 0;
  const m = q.modules;
  // First copy around the top-left finder (bit 14 … bit 0).
  const coords: [number, number][] = [];
  for (let i = 0; i <= 5; i++) coords.push([8, i]);
  coords.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) coords.push([14 - i, 8]);
  coords.forEach(([x, y], i) => { if (m[y]![x]) bits |= 1 << i; });
  for (const ecc of ['L', 'M', 'Q', 'H'] as Ecc[]) for (let mask = 0; mask < 8; mask++) {
    if (formatBits(ecc, mask) === bits) return { ecc, mask };
  }
  throw new Error('bad format info');
}

function functionMask(q: QrCode): boolean[][] {
  // Function modules from the standard's layout rules (finders + separators + format areas, timing,
  // version information, alignment patterns), derived independently of the encoder.
  const size = q.size;
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inFinder = (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8);
    const timing = x === 6 || y === 6;
    const ver = q.version >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6));
    fn[y]![x] = inFinder || timing || ver;
  }
  const pos = alignmentPositions(q.version);
  const n = pos.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn[pos[j]! + dy]![pos[i]! + dx] = true;
  }
  return fn;
}

const MASKS = [
  (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function decode(q: QrCode): string {
  const { ecc, mask } = readFormat(q);
  const fn = functionMask(q);
  const size = q.size;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (fn[y]![x]) continue;
      bits.push((q.modules[y]![x] !== MASKS[mask]!(x, y)) ? 1 : 0);
    }
  }
  const raw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) raw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave using the same block structure (re-derived from the public capacity function).
  const total = Math.floor(rawDataModules(q.version) / 8);
  const dataLen = dataCodewords(q.version, ecc);
  const blocksEcc = (total - dataLen);
  // Find the block count that matches the encoder's choice by re-encoding a probe of the same version.
  const probe = codewords(new Uint8Array(0), q.version, ecc);
  expect(probe.length).toBe(total);
  // Block count: smallest b such that ecc per block is integral and matches the tail structure.
  let numBlocks = 1;
  for (let b = 1; b <= 81; b++) if (blocksEcc % b === 0 && rsCheck(raw, total, dataLen, b)) { numBlocks = b; break; }
  const eccLen = blocksEcc / numBlocks;
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < numBlocks; j++) {
    if (i === shortLen - eccLen && j < numShort) continue;
    if (k < raw.length && blocks[j]!.length < (j < numShort ? shortLen : shortLen + 1)) blocks[j]!.push(raw[k++]!);
  }
  const data: number[] = [];
  for (const b of blocks) {
    const d = b.slice(0, b.length - eccLen);
    expect(rsRemainder(d, rsDivisor(eccLen))).toEqual(b.slice(b.length - eccLen));
    data.push(...d);
  }
  const dbits = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  const take = (n: number) => dbits.splice(0, n).reduce((a, b) => (a << 1) | b, 0);
  expect(take(4)).toBe(0b0100);
  const len = take(q.version <= 9 ? 8 : 16);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = take(8);
  return new TextDecoder().decode(out);
}

function rsCheck(raw: number[], total: number, dataLen: number, b: number): boolean {
  const eccLen = (total - dataLen) / b;
  const numShort = b - (total % b);
  const shortLen = Math.floor(total / b);
  if (shortLen - eccLen <= 0) return false;
  const blocks: number[][] = Array.from({ length: b }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < b; j++) {
    if (i === shortLen - eccLen && j < numShort) continue;
    if (k < raw.length && blocks[j]!.length < (j < numShort ? shortLen : shortLen + 1)) blocks[j]!.push(raw[k++]!);
  }
  return blocks.every((bl) => {
    const d = bl.slice(0, bl.length - eccLen);
    const e = rsRemainder(d, rsDivisor(eccLen));
    return e.every((v, i) => v === bl[bl.length - eccLen + i]);
  });
}

describe('encodeQr', () => {
  const samples: [string, Ecc][] = [
    ['https://kithwall.com/join?invite=0123456789abcdef01234567', 'M'],
    ['hello', 'L'],
    ['Kithwall — كيث وول — キス', 'Q'],
    ['x'.repeat(150), 'M'],   // version 8 (several blocks of different lengths)
    ['y'.repeat(300), 'L'],   // version ≥ 10 (16-bit length) with version information
  ];
  for (const [text, ecc] of samples) {
    it(`round-trips ${JSON.stringify(text.slice(0, 24))} at ${ecc}`, () => {
      const q = encodeQr(text, ecc);
      expect(q.size).toBe(q.version * 4 + 17);
      expect(decode(q)).toBe(text);
    });
  }
  it('round-trips with every mask', () => {
    for (let mask = 0; mask < 8; mask++) expect(decode(encodeQr('mask test 123', 'M', mask))).toBe('mask test 123');
  });
  it('draws finder patterns, timing and the dark module', () => {
    const q = encodeQr('abc', 'M');
    const row0 = q.modules[0]!.slice(0, 7).map((v) => (v ? 1 : 0)).join('');
    expect(row0).toBe('1111111');
    expect(q.modules[1]!.slice(0, 7).map((v) => (v ? 1 : 0)).join('')).toBe('1000001');
    expect(q.modules[6]!.slice(8, 13).map((v) => (v ? 1 : 0)).join('')).toBe('10101');
    expect(q.modules[q.size - 8]![8]).toBe(true);
  });
  it('picks a small version for invite links', () => {
    expect(encodeQr('https://kithwall.com/join?invite=0123456789abcdef01234567').version).toBeLessThanOrEqual(4);
  });
  it('builds an SVG path', () => {
    const q = encodeQr('a');
    expect(qrPath(q)).toMatch(/^M4 4h7v1h-7z/);
  });
  it('rejects data that cannot fit', () => {
    expect(() => encodeQr('z'.repeat(3000), 'H')).toThrow();
  });
});
