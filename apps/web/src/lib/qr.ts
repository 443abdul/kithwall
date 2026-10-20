// Minimal QR Code encoder (ISO/IEC 18004), byte mode, versions 1–40, error correction L/M/Q/H.
// Runs entirely on the device (no dependency, no network) for personal invite links. Structure follows
// the well-known reference algorithm by Project Nayuki (MIT): build codewords → Reed–Solomon blocks →
// interleave → zigzag placement → pick the mask with the lowest penalty.

export type Ecc = 'L' | 'M' | 'Q' | 'H';
const ECC_ORDINAL: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Format-information bits per level (L=01, M=00, Q=11, H=10). */
const ECC_FORMAT: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export interface QrCode { size: number; version: number; ecc: Ecc; mask: number; /** modules[y][x], true = dark */ modules: boolean[][] }

// ---------------------------------------------------------------------------------------------
// Reed–Solomon over GF(2^8) with the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).

export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i]! ^= gfMul(coef, factor); });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Capacity

export function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_ORDINAL[ecc];
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

// ---------------------------------------------------------------------------------------------
// Encoding

/** Data + error-correction codewords for `bytes` at a version/level (interleaved, ready to place). */
export function codewords(bytes: Uint8Array, ver: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(ver, ecc);
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = capacity * 8;
  if (bits.length > capBits) throw new Error('data too long');
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecw = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecw));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class Matrix {
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFn(x: number, y: number, dark: boolean) { this.modules[y]![x] = dark; this.fn[y]![x] = true; }
}

function drawFunctionPatterns(m: Matrix, ver: number, ecc: Ecc) {
  const size = m.size;
  for (let i = 0; i < size; i++) { m.setFn(6, i, i % 2 === 0); m.setFn(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) m.setFn(x, y, d !== 2 && d !== 4);
    }
  }
  const pos = alignmentPositions(ver);
  const n = pos.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.setFn(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(m, ecc, 0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      m.setFn(a, b, bit(bits, i)); m.setFn(b, a, bit(bits, i));
    }
  }
}

function drawFormat(m: Matrix, ecc: Ecc, mask: number) {
  const bits = formatBits(ecc, mask);
  const size = m.size;
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(bits, i));
  m.setFn(8, 7, bit(bits, 6)); m.setFn(8, 8, bit(bits, 7)); m.setFn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) m.setFn(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) m.setFn(8, size - 15 + i, bit(bits, i));
  m.setFn(8, size - 8, true); // the dark module
}

function placeData(m: Matrix, data: number[]) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.fn[y]![x] && i < data.length * 8) {
          m.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number) {
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) {
    if (!m.fn[y]![x] && maskBit(mask, x, y)) m.modules[y]![x] = !m.modules[y]![x];
  }
}

/** Penalty score (ISO 18004 §7.8.3; the finder-like rule is matched on 1:1:3:1:1 runs with light margins). */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    for (let i = 0; i + 7 <= size; i++) {
      const p = [1, 0, 1, 1, 1, 0, 1].every((v, k) => get(i + k) === (v === 1));
      if (!p) continue;
      const before = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const after = i + 11 <= size && [7, 8, 9, 10].every((k) => !get(i + k));
      if (before || after) score += 40;
    }
  };
  for (let y = 0; y < size; y++) line((i) => modules[y]![i]!);
  for (let x = 0; x < size; x++) line((i) => modules[i]![x]!);
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = modules[y]![x];
    if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const total = size * size;
  score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode text (UTF-8) as a QR code, choosing the smallest version that fits at the given level. */
export function encodeQr(text: string, ecc: Ecc = 'M', mask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  for (; ver <= 40; ver++) {
    const lenBits = ver <= 9 ? 8 : 16;
    if (4 + lenBits + bytes.length * 8 <= dataCodewords(ver, ecc) * 8) break;
  }
  if (ver > 40) throw new Error('data too long');
  const data = codewords(bytes, ver, ecc);
  const size = ver * 4 + 17;
  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (const mk of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const m = new Matrix(size);
    drawFunctionPatterns(m, ver, ecc);
    placeData(m, data);
    applyMask(m, mk);
    drawFormat(m, ecc, mk);
    const score = penalty(m.modules);
    if (!best || score < best.score) best = { mask: mk, modules: m.modules, score };
  }
  return { size, version: ver, ecc, mask: best!.mask, modules: best!.modules };
}

/** SVG path data ("M x y h1 v1 h-1 z" per dark module run) for drawing a QR code in a viewBox of size+2·quiet. */
export function qrPath(qr: QrCode, quiet = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y]![x]) { x++; continue; }
      let w = 1;
      while (x + w < qr.size && qr.modules[y]![x + w]) w++;
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h-${w}z`);
      x += w;
    }
  }
  return parts.join('');
}
