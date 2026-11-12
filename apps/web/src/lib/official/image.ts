// What kind of picture is this, and how large? Read from the file's own header (JPEG, PNG, WebP), never
// from what the server that sent it claims. The automated accounts attach a picture only when this says it
// is one of the three formats every browser shows, with sane dimensions.

export interface ImageInfo { mime: 'image/jpeg' | 'image/png' | 'image/webp'; w: number; h: number }

const MAX_SIDE = 12_000;
const ok = (mime: ImageInfo['mime'], w: number, h: number): ImageInfo | null =>
  w >= 16 && h >= 16 && w <= MAX_SIDE && h <= MAX_SIDE ? { mime, w, h } : null;

function jpeg(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }                      // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    // Start-of-frame markers (baseline, progressive, …) carry the size; C4, C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return ok('image/jpeg', (b[i + 7]! << 8) | b[i + 8]!, (b[i + 5]! << 8) | b[i + 6]!);
    }
    if (marker === 0xda) return null;                            // image data began without a frame header
    i += 2 + len;
  }
  return null;
}

const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (kind === 'VP8X') return ok('image/webp', u24le(b, 24) + 1, u24le(b, 27) + 1);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok('image/webp', (b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff);
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return ok('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** The format and pixel size of a JPEG, PNG or WebP file, or null when it is none of them. */
export function imageInfo(b: Uint8Array): ImageInfo | null {
  if (b.length < 26) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    // The first chunk must be IHDR: width and height follow its name.
    if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
    return ok('image/png', u32be(b, 16), u32be(b, 20));
  }
  if (String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP') return webp(b);
  return null;
}
