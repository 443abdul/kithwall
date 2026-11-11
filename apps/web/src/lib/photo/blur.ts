// "Blur faces" (post composer and chat attachments): covering parts of a photo before it is shared.
//
// The cover is destructive. Each chosen box is replaced, in the actual pixels, by a coarse mosaic: the box
// is cut into at most MOSAIC_CELLS cells along its longer side and every cell is filled with its average
// colour. What is left of a face is a few dozen flat colours, of a number plate or a line of text a handful,
// and nothing of the original pixels: there is no layer, no mask and no metadata to undo. The result is
// encoded as a new JPEG on this device and takes the original's place in the composer, so the existing
// path (re-encode, encrypt, upload: lib/media.ts) only ever sees the covered picture.
//
// The mosaic itself is a pure function over RGBA bytes (unit-tested in blur.test.ts); the canvas parts
// run only in a browser.

/** A box in fractions of the image: (0,0) is the top left corner, (1,1) the bottom right. */
export interface Box { x: number; y: number; w: number; h: number }

/** Cells along the longer side of a box. Fewer cells = less left; 6 keeps no feature of a face or letter. */
export const MOSAIC_CELLS = 6;
/** A box is grown by this share of its size on every side before covering (hair, chin, plate frame). */
export const FACE_MARGIN = 0.18;
/** Largest side of the covered photo (the largest size the app ever uploads is 2048 px, lib/media.ts). */
export const MAX_SIDE = 4096;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A box kept inside the image, with positive size. */
export function clampBox(b: Box): Box {
  const x = clamp01(Math.min(b.x, b.x + b.w));
  const y = clamp01(Math.min(b.y, b.y + b.h));
  const x2 = clamp01(Math.max(b.x, b.x + b.w));
  const y2 = clamp01(Math.max(b.y, b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** The box grown by `margin` of its size on every side (and kept inside the image). */
export function growBox(b: Box, margin = FACE_MARGIN): Box {
  return clampBox({ x: b.x - b.w * margin, y: b.y - b.h * margin, w: b.w * (1 + 2 * margin), h: b.h * (1 + 2 * margin) });
}

/** The pixel rectangle of a box in an image of this size (whole pixels, at least 1×1, inside the image). */
export function boxPixels(b: Box, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const c = clampBox(b);
  const x = Math.min(width - 1, Math.floor(c.x * width));
  const y = Math.min(height - 1, Math.floor(c.y * height));
  const w = Math.max(1, Math.min(width - x, Math.ceil((c.x + c.w) * width) - x));
  const h = Math.max(1, Math.min(height - y, Math.ceil((c.y + c.h) * height) - y));
  return { x, y, w, h };
}

/**
 * Replace an RGBA region by its mosaic, in place: `cells` cells along the longer side (square cells, so
 * fewer along the shorter one), each filled with the average colour of the pixels it covers. Fully opaque.
 */
export function mosaic(data: Uint8ClampedArray, width: number, height: number, cells = MOSAIC_CELLS): void {
  const cell = Math.max(1, Math.ceil(Math.max(width, height) / Math.max(1, cells)));
  for (let y0 = 0; y0 < height; y0 += cell) {
    for (let x0 = 0; x0 < width; x0 += cell) {
      const x1 = Math.min(width, x0 + cell);
      const y1 = Math.min(height, y0 + cell);
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) {
        for (let p = (y * width + x0) * 4, end = (y * width + x1) * 4; p < end; p += 4) { r += data[p]!; g += data[p + 1]!; b += data[p + 2]!; }
      }
      const n = (x1 - x0) * (y1 - y0);
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      for (let y = y0; y < y1; y++) {
        for (let p = (y * width + x0) * 4, end = (y * width + x1) * 4; p < end; p += 4) { data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255; }
      }
    }
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Cover the boxes on a canvas that already shows the photo. */
export function coverBoxes(ctx: Ctx, width: number, height: number, boxes: readonly Box[]): void {
  for (const b of boxes) {
    const px = boxPixels(b, width, height);
    const img = ctx.getImageData(px.x, px.y, px.w, px.h);
    mosaic(img.data, px.w, px.h);
    ctx.putImageData(img, px.x, px.y);
  }
}

/** Decode a picked photo the right way up, no larger than `maxSide`, onto a canvas. */
export async function photoCanvas(file: Blob, maxSide = MAX_SIDE): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, ctx };
  } finally { bitmap.close(); }
}

/**
 * The photo with the boxes covered, as a new JPEG file. Nothing of the original file is carried over
 * (the pixels are redrawn, so its EXIF data goes too); the caller drops the original.
 */
export async function coverPhoto(file: File, boxes: readonly Box[]): Promise<File> {
  const { canvas, ctx } = await photoCanvas(file);
  coverBoxes(ctx, canvas.width, canvas.height, boxes);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  // Free the pixels now rather than at the next garbage collection (photos are large on phones).
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Could not encode the photo');
  const name = file.name.replace(/\.[^.]*$/, '') || 'photo';
  return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}
