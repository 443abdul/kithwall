'use client';
// Kit Drop files opened in the Android app from outside (share sheet, "Open with" in Files, Quick Share):
// MainActivity copies the file into the app's cache and opens /you/kitdrop?incoming=…; the page then reads
// the copy here, in base64 chunks over the plugin bridge (the page can't fetch content:// or file:// URLs),
// and opens it with the usual checks (lib/social/kitdrop openKitDrop). The copy is deleted right after.
import { isNative, nativePlugin } from './index';
import { MAX_FILE_BYTES } from '../social/kitdropFormat';

function bytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The Kit Drop file handed to the app, if any (null: none waiting). Throws 'too_big'. */
export async function takeIncomingKitDrop(): Promise<File | null> {
  if (!isNative()) return null;
  const shell = await nativePlugin('KithwallShell');
  const p = await shell.kitdropPending().catch(() => ({} as { id?: string; name?: string; size?: number }));
  if (!p.id) return null;
  try {
    const size = p.size ?? 0;
    if (size > MAX_FILE_BYTES) throw new Error('too_big');
    const parts: Uint8Array[] = [];
    for (let off = 0; off < size;) {
      const { data } = await shell.kitdropRead({ id: p.id, offset: off });
      const chunk = bytes(data);
      if (!chunk.length) break;
      parts.push(chunk);
      off += chunk.length;
    }
    return new File(parts as BlobPart[], p.name || 'kitdrop.kwd', { type: 'application/octet-stream' });
  } finally {
    await shell.kitdropDone({ id: p.id }).catch(() => undefined);
  }
}
