'use client';
// Finding faces in a photo, on this device only ("Blur faces", lib/photo/blur.ts). Nothing here sends the
// photo, or anything about it, anywhere: the only request is for the detector's own data file, from this
// app's origin, the first time someone opens the tool.
//
//  1. The browser's own FaceDetector (Shape Detection API: Chrome on Android, macOS and ChromeOS) when it
//     exists and works.
//  2. Otherwise the small self-hosted detector in ./pico.ts (240 kB, loaded now, not before): Firefox,
//     Safari, Chrome on Windows and Linux, and the Kithwall Android app's WebView.
//  3. If neither works (the file can't be fetched, say), the answer is "none": the person still draws
//     boxes by hand.
// No detector finds every face. The screen says so, and there is no detection at all of number plates,
// documents or house numbers.
import { growBox, type Box } from './blur';
import { FACE_SCORE, findFaces, toGrey, unpackCascade, type Cascade } from './pico';

export type FaceEngine = 'builtin' | 'model' | 'none';
export interface FaceResult { engine: FaceEngine; faces: Box[] }

interface DetectedFace { boundingBox: DOMRectReadOnly }
interface FaceDetectorLike { detect(source: CanvasImageSource): Promise<DetectedFace[]> }
type FaceDetectorCtor = new (opts?: { fastMode?: boolean; maxDetectedFaces?: number }) => FaceDetectorLike;

const CASCADE_URL = '/models/pico/facefinder.bin';
/** SHA-256 of the cascade file (public/models/pico/facefinder.bin): anything else is refused. */
export const CASCADE_SHA256 = 'd8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd';

let cascade: Promise<Cascade> | null = null;
function loadCascade(): Promise<Cascade> {
  cascade ??= (async () => {
    const res = await fetch(CASCADE_URL, { credentials: 'omit' });
    if (!res.ok) throw new Error('detector unavailable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if ([...digest].map((b) => b.toString(16).padStart(2, '0')).join('') !== CASCADE_SHA256) throw new Error('detector file changed');
    return unpackCascade(bytes);
  })();
  // A failed load (offline) may work next time.
  cascade.catch(() => { cascade = null; });
  return cascade;
}

async function builtin(canvas: HTMLCanvasElement): Promise<Box[] | null> {
  const Ctor = (globalThis as { FaceDetector?: FaceDetectorCtor }).FaceDetector;
  if (typeof Ctor !== 'function') return null;
  try {
    const found = await new Ctor({ fastMode: false, maxDetectedFaces: 40 }).detect(canvas);
    return found.map((f) => ({ x: f.boundingBox.x / canvas.width, y: f.boundingBox.y / canvas.height, w: f.boundingBox.width / canvas.width, h: f.boundingBox.height / canvas.height }));
  } catch {
    // Declared but not working here (desktop Chrome without the platform service): use our own detector.
    return null;
  }
}

/** Yield to the page so the spinner keeps turning while the scan runs. */
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

async function model(canvas: HTMLCanvasElement): Promise<Box[]> {
  const k = await loadCascade();
  // A working copy: large enough for faces a few percent of the picture wide, small enough for a phone.
  const slow = (navigator.hardwareConcurrency ?? 4) <= 4;
  const scale = Math.min(1, (slow ? 600 : 800) / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas not available');
  ctx.drawImage(canvas, 0, 0, w, h);
  const grey = toGrey(ctx.getImageData(0, 0, w, h).data, w, h);
  small.width = small.height = 0;
  let last = performance.now();
  const found = await findFaces(k, grey, h, w, {
    pause: async () => { if (performance.now() - last > 40) { await pause(); last = performance.now(); } },
  });
  return found.filter((d) => d.q >= FACE_SCORE).map((d) => ({ x: (d.c - d.s / 2) / w, y: (d.r - d.s / 2) / h, w: d.s / w, h: d.s / h }));
}

/** Faces in the photo on this canvas, each grown a little so the cover reaches hair and chin. */
export async function detectFaces(canvas: HTMLCanvasElement): Promise<FaceResult> {
  const own = await builtin(canvas);
  if (own) return { engine: 'builtin', faces: own.map((b) => growBox(b)) };
  try {
    return { engine: 'model', faces: (await model(canvas)).map((b) => growBox(b)) };
  } catch {
    return { engine: 'none', faces: [] };
  }
}
