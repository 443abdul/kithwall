import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boxPixels, clampBox, growBox, mosaic, MOSAIC_CELLS } from './blur';
import { CASCADE_SHA256 } from './faces';
import { classifyWindow, clusterDetections, FACE_SCORE, findFaces, mirrorGrey, scanSizes, toGrey, unpackCascade } from './pico';

const cascadeBytes = new Uint8Array(readFileSync(join(__dirname, '..', '..', '..', 'public', 'models', 'pico', 'facefinder.bin')));
// A 160×238 grey copy of a public-domain painting (Leonardo da Vinci, Mona Lisa; Wikimedia Commons).
const PORTRAIT = { pixels: new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'portrait-160.grey'))), cols: 160, rows: 238 };

function noise(w: number, h: number, seed = 7): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % 256; };
  for (let i = 0; i < d.length; i++) d[i] = i % 4 === 3 ? 200 : next();
  return d;
}

describe('boxes', () => {
  it('are kept inside the image and made positive', () => {
    expect(clampBox({ x: -0.2, y: 0.5, w: 0.5, h: 0.9 })).toEqual({ x: 0, y: 0.5, w: 0.3, h: 0.5 });
    const flipped = clampBox({ x: 0.8, y: 0.8, w: -0.3, h: -0.2 });
    expect(flipped.x).toBeCloseTo(0.5); expect(flipped.y).toBeCloseTo(0.6); expect(flipped.w).toBeCloseTo(0.3); expect(flipped.h).toBeCloseTo(0.2);
    expect(clampBox({ x: 2, y: 2, w: 1, h: 1 })).toEqual({ x: 1, y: 1, w: 0, h: 0 });
  });

  it('grow by a margin on every side', () => {
    const g = growBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.25);
    expect(g.x).toBeCloseTo(0.35); expect(g.y).toBeCloseTo(0.35); expect(g.w).toBeCloseTo(0.3); expect(g.h).toBeCloseTo(0.3);
    // Growing stops at the edge of the picture.
    expect(growBox({ x: 0, y: 0, w: 0.5, h: 1 }, 0.5)).toEqual({ x: 0, y: 0, w: 0.75, h: 1 });
  });

  it('map to whole pixels that never leave the image', () => {
    expect(boxPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 200, 100)).toEqual({ x: 50, y: 50, w: 100, h: 25 });
    expect(boxPixels({ x: 0.999, y: 0.999, w: 0.5, h: 0.5 }, 10, 10)).toEqual({ x: 9, y: 9, w: 1, h: 1 });
    expect(boxPixels({ x: 0, y: 0, w: 1, h: 1 }, 33, 17)).toEqual({ x: 0, y: 0, w: 33, h: 17 });
    for (const b of [{ x: 0.13, y: 0.77, w: 0.31, h: 0.4 }, { x: -1, y: -1, w: 5, h: 5 }, { x: 0.5, y: 0.5, w: 0, h: 0 }]) {
      const p = boxPixels(b, 97, 53);
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.w).toBeGreaterThanOrEqual(1); expect(p.h).toBeGreaterThanOrEqual(1);
      expect(p.x + p.w).toBeLessThanOrEqual(97); expect(p.y + p.h).toBeLessThanOrEqual(53);
    }
  });
});

describe('mosaic', () => {
  const distinct = (d: Uint8ClampedArray) => new Set(Array.from({ length: d.length / 4 }, (_, i) => `${d[i * 4]},${d[i * 4 + 1]},${d[i * 4 + 2]}`)).size;

  it('leaves at most cells × cells colours of a region, whatever was in it', () => {
    const w = 120, h = 90;
    const d = noise(w, h);
    expect(distinct(d)).toBeGreaterThan(5000);
    mosaic(d, w, h);
    // Cells are square: 6 along the longer side (20 px), so 5 rows here.
    expect(distinct(d)).toBeLessThanOrEqual(MOSAIC_CELLS * 5);
    // Every pixel of a cell is the same colour.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) expect([d[(y * w + x) * 4], d[(y * w + x) * 4 + 1], d[(y * w + x) * 4 + 2]]).toEqual([d[0], d[1], d[2]]);
  });

  it('fills each cell with the average of what it covered, fully opaque', () => {
    const w = 12, h = 6; // two 6×6 cells
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const left = x < 6;
      d[p] = left ? (x % 2 ? 100 : 200) : 10; d[p + 1] = left ? 0 : 20; d[p + 2] = left ? 255 : 30; d[p + 3] = 17;
    }
    mosaic(d, w, h, 2);
    expect([...d.slice(0, 4)]).toEqual([150, 0, 255, 255]);
    expect([...d.slice(6 * 4, 6 * 4 + 4)]).toEqual([10, 20, 30, 255]);
  });

  it("can't be undone: different originals give the same result when their cell averages match", () => {
    const w = 60, h = 60;
    const a = new Uint8ClampedArray(w * h * 4);
    const b = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      // Two very different pictures: fine stripes one way, the other way; same average in every 10 px cell.
      const va = x % 2 ? 40 : 200; const vb = y % 2 ? 40 : 200;
      a[p] = a[p + 1] = a[p + 2] = va; b[p] = b[p + 1] = b[p + 2] = vb; a[p + 3] = b[p + 3] = 255;
    }
    expect([...a]).not.toEqual([...b]);
    mosaic(a, w, h); mosaic(b, w, h);
    expect([...a]).toEqual([...b]);
  });

  it('handles tiny and odd regions', () => {
    const one = new Uint8ClampedArray([9, 8, 7, 0]);
    mosaic(one, 1, 1);
    expect([...one]).toEqual([9, 8, 7, 255]);
    const odd = noise(7, 3);
    mosaic(odd, 7, 3);
    expect(distinct(odd)).toBeLessThanOrEqual(MOSAIC_CELLS * 2);
    const strip = noise(300, 4);
    mosaic(strip, 300, 4);
    expect(distinct(strip)).toBeLessThanOrEqual(MOSAIC_CELLS);
  });
});

describe('face cascade', () => {
  const k = unpackCascade(cascadeBytes);

  it('is the file the app expects, and parses', () => {
    expect(createHash('sha256').update(cascadeBytes).digest('hex')).toBe(CASCADE_SHA256);
    expect(k.depth).toBe(6);
    expect(k.trees).toBe(468);
    expect(k.codes.length).toBe(468 * 4 * 64);
    expect(k.preds.length).toBe(468 * 64);
    expect(() => unpackCascade(cascadeBytes.slice(0, 1000))).toThrow();
    expect(() => unpackCascade(new Uint8Array(64))).toThrow();
  });

  it('finds the face in a portrait, where it is', async () => {
    const found = (await findFaces(k, PORTRAIT.pixels, PORTRAIT.rows, PORTRAIT.cols)).filter((d) => d.q >= FACE_SCORE);
    expect(found).toHaveLength(1);
    const f = found[0]!;
    // The face is in the upper middle of the painting, about 47 px across.
    expect(Math.abs(f.c - 72)).toBeLessThan(8);
    expect(Math.abs(f.r - 59)).toBeLessThan(8);
    expect(f.s).toBeGreaterThan(36); expect(f.s).toBeLessThan(60);
    expect(f.q).toBeGreaterThan(100);
  });

  it('finds the same face in the mirror image', async () => {
    const flipped = mirrorGrey(PORTRAIT.pixels, PORTRAIT.rows, PORTRAIT.cols);
    expect([...mirrorGrey(flipped, PORTRAIT.rows, PORTRAIT.cols)]).toEqual([...PORTRAIT.pixels]);
    const found = (await findFaces(k, flipped, PORTRAIT.rows, PORTRAIT.cols)).filter((d) => d.q >= FACE_SCORE);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0]!.c - (PORTRAIT.cols - 1 - 72))).toBeLessThan(8);
  });

  it('finds nothing in flat or random pictures', async () => {
    const flat = new Uint8Array(200 * 200).fill(128);
    expect((await findFaces(k, flat, 200, 200)).filter((d) => d.q >= FACE_SCORE)).toEqual([]);
    const rnd = toGrey(noise(200, 200), 200, 200);
    expect((await findFaces(k, rnd, 200, 200)).filter((d) => d.q >= FACE_SCORE)).toEqual([]);
    const gradient = Uint8Array.from({ length: 200 * 200 }, (_, i) => (i % 200) + ((i / 200) | 0) / 4);
    expect((await findFaces(k, gradient, 200, 200)).filter((d) => d.q >= FACE_SCORE)).toEqual([]);
  });

  it('pauses between slices of work', async () => {
    let pauses = 0;
    await findFaces(k, PORTRAIT.pixels, PORTRAIT.rows, PORTRAIT.cols, { pause: async () => { pauses++; } });
    expect(pauses).toBeGreaterThan(scanSizes({ minSize: 24, maxSize: 160 }).length);
  });

  it('rejects a window that is not a face and scores one that is', () => {
    expect(classifyWindow(k, 59, 72, 47, PORTRAIT.pixels, PORTRAIT.cols)).toBeGreaterThan(0);
    expect(classifyWindow(k, 200, 80, 47, PORTRAIT.pixels, PORTRAIT.cols)).toBe(-1);
  });

  it('merges overlapping detections and adds their scores', () => {
    const merged = clusterDetections([
      { r: 50, c: 50, s: 40, q: 3 }, { r: 52, c: 51, s: 42, q: 5 }, { r: 49, c: 48, s: 38, q: 2 }, { r: 150, c: 150, s: 30, q: 1 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.q).toBe(10);
    expect(merged[0]!.s).toBeCloseTo(40);
    expect(merged[1]).toEqual({ r: 150, c: 150, s: 30, q: 1 });
  });

  it('turns RGBA into grey', () => {
    expect([...toGrey(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 100, 0, 0, 255]), 3, 1)]).toEqual([255, 0, 20]);
  });
});
