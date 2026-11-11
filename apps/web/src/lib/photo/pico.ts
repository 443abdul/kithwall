// Face detection without a browser API, a neural-network runtime or WebAssembly: "pico", pixel intensity
// comparisons organised in decision trees (N. Markuš, M. Frljak, I. S. Pandžić, J. Ahlberg, R. Forchheimer,
// "Object Detection with Pixel Intensity Comparisons Organized in Decision Trees", arXiv:1305.4537).
// This file is our own TypeScript implementation of the published algorithm; the trained face cascade it
// reads (public/models/pico/facefinder.bin, 240 kB, MIT licence, see LICENSE.txt next to it) comes from the
// author's repository github.com/nenadmarkus/pico.
//
// Why this and not a neural network: the alternatives (MediaPipe / BlazeFace through TensorFlow.js or the
// MediaPipe WASM runtime) need 1.5 to 10 MB of code on top of the model. This is 240 kB of data and the
// few functions below, runs anywhere JavaScript runs (the Android WebView included), needs no change to the
// Content-Security-Policy and loads only when someone opens "Blur faces". It finds faces that look towards
// the camera; faces turned away, strongly tilted or very small can be missed, which the screen says and
// the manual boxes cover. Where the browser has its own FaceDetector, that is used instead (faces.ts).
//
// Pure functions over a grey image; unit-tested in blur.test.ts.

export interface Cascade {
  depth: number;
  trees: number;
  /** Per tree: 4 × 2^depth signed bytes (two pixel offsets per inner node; node 0 is unused). */
  codes: Int8Array;
  /** Per tree: 2^depth leaf scores. */
  preds: Float32Array;
  /** Per tree: the running score below which a window is rejected at once. */
  thresh: Float32Array;
}

/** Read a cascade in pico's binary format. Throws on anything that isn't one. */
export function unpackCascade(bytes: Uint8Array): Cascade {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16) throw new Error('not a cascade');
  // 8 bytes of header (format version and the training window), then depth and tree count.
  const depth = view.getInt32(8, true);
  const trees = view.getInt32(12, true);
  if (depth < 1 || depth > 12 || trees < 1 || trees > 4096) throw new Error('not a cascade');
  const leaves = 1 << depth;
  const perTree = 4 * leaves - 4 + 4 * leaves + 4;
  if (bytes.byteLength !== 16 + trees * perTree) throw new Error('not a cascade');
  const codes = new Int8Array(trees * 4 * leaves);
  const preds = new Float32Array(trees * leaves);
  const thresh = new Float32Array(trees);
  let p = 16;
  for (let t = 0; t < trees; t++) {
    for (let i = 4; i < 4 * leaves; i++) codes[t * 4 * leaves + i] = view.getInt8(p++);
    for (let i = 0; i < leaves; i++, p += 4) preds[t * leaves + i] = view.getFloat32(p, true);
    thresh[t] = view.getFloat32(p, true);
    p += 4;
  }
  return { depth, trees, codes, preds, thresh };
}

/**
 * Score one square window (centre row r, centre column c, side s, all in pixels of the grey image):
 * a positive number for "a face", -1 as soon as the cascade rejects it. The caller keeps the window inside
 * the image.
 */
export function classifyWindow(k: Cascade, r: number, c: number, s: number, pixels: Uint8Array, cols: number): number {
  const R = 256 * r;
  const C = 256 * c;
  const leaves = 1 << k.depth;
  let root = 0;
  let o = 0;
  for (let t = 0; t < k.trees; t++) {
    let idx = 1;
    for (let d = 0; d < k.depth; d++) {
      const n = root + 4 * idx;
      const a = pixels[((R + k.codes[n]! * s) >> 8) * cols + ((C + k.codes[n + 1]! * s) >> 8)]!;
      const b = pixels[((R + k.codes[n + 2]! * s) >> 8) * cols + ((C + k.codes[n + 3]! * s) >> 8)]!;
      idx = 2 * idx + (a <= b ? 1 : 0);
    }
    o += k.preds[leaves * t + idx - leaves]!;
    if (o <= k.thresh[t]!) return -1;
    root += 4 * leaves;
  }
  return o - k.thresh[k.trees - 1]!;
}

export interface Detection { r: number; c: number; s: number; q: number }
export interface ScanOptions {
  /** Smallest and largest face side to look for, in pixels. */
  minSize: number;
  maxSize: number;
  /** Step between windows as a fraction of their size (0.1), and the growth between sizes (1.1). */
  shift?: number;
  scale?: number;
}

/** The window sizes a scan visits, smallest first. */
export function scanSizes(o: ScanOptions): number[] {
  const out: number[] = [];
  for (let s = Math.max(o.minSize, 16); s <= o.maxSize; s *= o.scale ?? 1.1) out.push(s);
  return out;
}

/** Every window of one size that the cascade accepts. */
export function scanSize(k: Cascade, pixels: Uint8Array, rows: number, cols: number, size: number, shift = 0.1): Detection[] {
  const out: Detection[] = [];
  const step = Math.max(shift * size, 1) | 0;
  const offset = (size / 2 + 1) | 0;
  for (let r = offset; r <= rows - offset; r += step) {
    for (let c = offset; c <= cols - offset; c += step) {
      const q = classifyWindow(k, r, c, size, pixels, cols);
      if (q > 0) out.push({ r, c, s: size, q });
    }
  }
  return out;
}

function iou(a: Detection, b: Detection): number {
  const overR = Math.max(0, Math.min(a.r + a.s / 2, b.r + b.s / 2) - Math.max(a.r - a.s / 2, b.r - b.s / 2));
  const overC = Math.max(0, Math.min(a.c + a.s / 2, b.c + b.s / 2) - Math.max(a.c - a.s / 2, b.c - b.s / 2));
  return (overR * overC) / (a.s * a.s + b.s * b.s - overR * overC);
}

/**
 * A real face is accepted in many neighbouring windows; a false alarm in one or two. Overlapping windows
 * are merged into one detection whose score is the sum of theirs, so the caller can keep the strong ones.
 */
export function clusterDetections(dets: Detection[], overlap = 0.2): Detection[] {
  const sorted = [...dets].sort((a, b) => b.q - a.q);
  const used = new Uint8Array(sorted.length);
  const out: Detection[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    let r = 0, c = 0, s = 0, q = 0, n = 0;
    for (let j = i; j < sorted.length; j++) {
      if (used[j] || iou(sorted[i]!, sorted[j]!) <= overlap) continue;
      used[j] = 1;
      r += sorted[j]!.r; c += sorted[j]!.c; s += sorted[j]!.s; q += sorted[j]!.q; n++;
    }
    out.push({ r: r / n, c: c / n, s: s / n, q });
  }
  return out;
}

/** The image flipped left to right (the cascade is not symmetric: a face it misses one way it may find the other). */
export function mirrorGrey(pixels: Uint8Array, rows: number, cols: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let r = 0; r < rows; r++) {
    const row = r * cols;
    for (let c = 0; c < cols; c++) out[row + c] = pixels[row + cols - 1 - c]!;
  }
  return out;
}

/** A merged detection scores at least this much for a real face (tuned on frontal and three-quarter faces). */
export const FACE_SCORE = 12;

/**
 * Find faces in a grey image. Two steps keep it fast enough for a phone:
 *  1. a coarse scan of the image and its mirror image (windows a tenth of their size apart);
 *  2. around every place the coarse scan accepted, a dense scan (a twentieth apart, five sizes), which a
 *     real face passes in dozens of windows and a false alarm in a handful.
 * Returns merged detections with their summed score, strongest first; keep those ≥ FACE_SCORE.
 * `pause` is awaited between slices of work, so the page stays responsive.
 */
export async function findFaces(k: Cascade, pixels: Uint8Array, rows: number, cols: number,
  opts: { minSize?: number; maxSeeds?: number; pause?: () => Promise<void> } = {}): Promise<Detection[]> {
  const sides: [Uint8Array, boolean][] = [[pixels, false], [mirrorGrey(pixels, rows, cols), true]];
  const sizes = scanSizes({ minSize: opts.minSize ?? 24, maxSize: Math.min(rows, cols) });
  const seeds: (Detection & { flip: boolean })[] = [];
  for (const [side, flip] of sides) {
    for (const s of sizes) {
      for (const d of scanSize(k, side, rows, cols, s)) seeds.push({ ...d, flip });
      await opts.pause?.();
    }
  }
  // One dense scan per place, not per coarse window; the strongest places first if there are very many.
  const places = clusterDetections(seeds).sort((a, b) => b.q - a.q).slice(0, opts.maxSeeds ?? 80);
  const fine: Detection[] = [];
  for (const place of places) {
    for (const [side, flip] of sides) {
      const pc = flip ? cols - 1 - place.c : place.c;
      for (const grow of [0.84, 0.92, 1, 1.09, 1.19]) {
        const s = place.s * grow;
        const half = (s / 2 + 1) | 0;
        for (let dr = -0.2; dr <= 0.2001; dr += 0.05) {
          for (let dc = -0.2; dc <= 0.2001; dc += 0.05) {
            const r = Math.round(place.r + dr * s);
            const c = Math.round(pc + dc * s);
            if (r < half || c < half || r > rows - half || c > cols - half) continue;
            const q = classifyWindow(k, r, c, s, side, cols);
            if (q > 0) fine.push({ r, c: flip ? cols - 1 - c : c, s, q });
          }
        }
      }
    }
    await opts.pause?.();
  }
  return clusterDetections(fine).sort((a, b) => b.q - a.q);
}

/** RGBA pixels (canvas ImageData) to the grey bytes the cascade reads. */
export function toGrey(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const grey = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) grey[i] = (2 * rgba[p]! + 7 * rgba[p + 1]! + rgba[p + 2]!) / 10;
  return grey;
}
