'use client';
// Frame encryption (insertable streams) on the main thread side: feature detection and wiring senders /
// receivers to the worker in public/calls-e2ee.js. See that file for the format.
//
// Where neither RTCRtpScriptTransform nor createEncodedStreams exists, calls still work: media is
// protected by DTLS-SRTP, whose keys are authenticated by fingerprints inside the signed signalling, so
// it is end-to-end between the two devices either way. The UI just doesn't claim the extra layer.

export type FrameMode = 'script' | 'streams' | null;

interface LegacySender { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } }
declare const RTCRtpScriptTransform: { new (worker: Worker, options?: unknown, transfer?: Transferable[]): unknown } | undefined;

export function frameMode(): FrameMode {
  if (typeof window === 'undefined' || typeof RTCRtpSender === 'undefined') return null;
  try { if (localStorage.getItem('kw.calls.noFrameE2EE') === '1') return null; } catch { /* ignore */ }
  if (typeof RTCRtpScriptTransform !== 'undefined') return 'script';
  if (typeof (RTCRtpSender.prototype as unknown as LegacySender).createEncodedStreams === 'function') return 'streams';
  return null;
}

export interface FrameStats { enc: number; dec: number; fail: number }

export class FrameCrypto {
  private worker: Worker;
  private last: FrameStats = { enc: 0, dec: 0, fail: 0 };
  constructor(readonly mode: Exclude<FrameMode, null>, callKey: Uint8Array) {
    this.worker = new Worker('/calls-e2ee.js', { name: 'kithwall-call-e2ee' });
    this.worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string } & Partial<FrameStats>;
      if (d?.type === 'stats') this.last = { enc: d.enc ?? 0, dec: d.dec ?? 0, fail: d.fail ?? 0 };
    };
    const buf = callKey.slice().buffer;
    this.worker.postMessage({ type: 'key', key: buf }, [buf]);
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, op: 'encrypt' | 'decrypt', ep: string) {
    if (this.mode === 'script') {
      (target as unknown as { transform: unknown }).transform = new RTCRtpScriptTransform!(this.worker, { op, ep });
      return;
    }
    const s = (target as unknown as LegacySender).createEncodedStreams?.();
    if (!s) return;
    this.worker.postMessage({ type: 'streams', op, ep, readable: s.readable, writable: s.writable }, [s.readable as unknown as Transferable, s.writable as unknown as Transferable]);
  }

  /** My frames to this peer, under my endpoint's key. */
  sender(sender: RTCRtpSender, myEndpoint: string) { this.attach(sender, 'encrypt', myEndpoint); }
  /** Their frames, under their endpoint's key. */
  receiver(receiver: RTCRtpReceiver, theirEndpoint: string) { this.attach(receiver, 'decrypt', theirEndpoint); }

  /** Counters from the worker (refreshed asynchronously; returns the last known values). */
  stats(): FrameStats {
    this.worker.postMessage({ type: 'stats' });
    return this.last;
  }

  close() { this.worker.terminate(); }
}
