'use client';
// Photo attachments for messages. The image is decoded and re-encoded on the device (which drops
// EXIF/GPS metadata), encrypted with a fresh file key and uploaded to my folder unlinked. The
// file key travels inside the message envelope. Order that keeps attachments readable:
//   1. upload (only I can fetch it)  2. insert the message  3. link the files to the message row
// Readers who see the message before step 3 finishes retry the download (see <Attachment>).
import { deleteMedia, linkMedia, MAX_PHOTO_BYTES, uploadEncrypted } from '../media';
import type { FileRef } from '../types';

export const MAX_ATTACHMENTS = 6;
const MAX_SIDE = 1600;

export async function prepareAttachment(file: File): Promise<FileRef> {
  if (!file.type.startsWith('image/')) throw new Error('Only photos can be attached.');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('Photos must be 20 MB or smaller.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('That photo couldn\'t be read.'); }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
    const ref = await uploadEncrypted(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg');
    return { ...ref, w, h };
  } finally {
    bitmap.close();
  }
}

export async function linkAttachments(refs: FileRef[], messageId: string) {
  await linkMedia(refs.map((r) => r.path), { messageId });
}

/** Remove uploads that never made it into a message. */
export async function discardAttachments(refs: FileRef[]) {
  await deleteMedia(refs.map((r) => r.path));
}
