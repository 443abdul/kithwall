/* Kithwall call frame encryption worker (docs/v2/04-calls.md §4).
 *
 * Defence in depth on top of DTLS-SRTP: every encoded audio/video frame is encrypted with AES-256-GCM
 * before the browser packetises it, and decrypted after it is reassembled, so the media stays sealed
 * even if a transport hop were ever terminated by someone else.
 *
 *   sender key(ep) = HKDF-SHA-256(callKey, salt = "", info = "kithwall/v1/call-frame/<endpoint>")
 *   frame          = clear[h] ‖ AES-GCM(key, iv, aad = clear[h], payload) ‖ iv[12] ‖ 0x4b
 *
 * callKey is 32 random bytes chosen by the caller and sent inside the sealed, signed ring message. Each
 * device ("endpoint") encrypts with its own derived key. The first few bytes of each frame stay in the
 * clear (VP8 key frame 10, delta frame 3, audio 1: the codec's own frame header, which the RTP packetiser
 * reads); they are authenticated as AAD. Frames that fail to decrypt are dropped, never played.
 *
 * Driven either by RTCRtpScriptTransform (Safari, Firefox, newer Chrome: the `rtctransform` event) or by
 * the older Chrome insertable streams (`createEncodedStreams`, streams posted in a message).
 */
'use strict';

const MARK = 0x4b;
const enc = new TextEncoder();
let callKey = null;
let keys = new Map();
const stats = { enc: 0, dec: 0, fail: 0 };

function keyFor(ep) {
  if (!callKey) return Promise.reject(new Error('no key'));
  let p = keys.get(ep);
  if (!p) {
    p = crypto.subtle.importKey('raw', callKey, 'HKDF', false, ['deriveKey']).then((base) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('kithwall/v1/call-frame/' + ep) },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    keys.set(ep, p);
  }
  return p;
}

function clearBytes(frame) {
  if (frame.type === 'key') return 10;
  if (frame.type === 'delta') return 3;
  return 1; // audio frames have no type
}

async function encryptFrame(frame, controller, ep) {
  const data = new Uint8Array(frame.data);
  if (!data.length) { controller.enqueue(frame); return; }
  try {
    const key = await keyFor(ep);
    const h = Math.min(clearBytes(frame), data.length);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: data.subarray(0, h) }, key, data.subarray(h)));
    const out = new Uint8Array(h + ct.length + 13);
    out.set(data.subarray(0, h), 0);
    out.set(ct, h);
    out.set(iv, h + ct.length);
    out[out.length - 1] = MARK;
    frame.data = out.buffer;
    stats.enc++;
    controller.enqueue(frame);
  } catch (_) {
    stats.fail++; // never send a frame in the clear
  }
}

async function decryptFrame(frame, controller, ep) {
  const data = new Uint8Array(frame.data);
  if (!data.length) { controller.enqueue(frame); return; }
  try {
    const h = Math.min(clearBytes(frame), data.length);
    if (data.length < h + 16 + 13 || data[data.length - 1] !== MARK) throw new Error('not sealed');
    const key = await keyFor(ep);
    const iv = data.subarray(data.length - 13, data.length - 1);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: data.subarray(0, h) }, key, data.subarray(h, data.length - 13)));
    const out = new Uint8Array(h + pt.length);
    out.set(data.subarray(0, h), 0);
    out.set(pt, h);
    frame.data = out.buffer;
    stats.dec++;
    controller.enqueue(frame);
  } catch (_) {
    stats.fail++; // dropped: never play something that didn't authenticate
  }
}

function pipe(readable, writable, op, ep) {
  const fn = op === 'encrypt' ? encryptFrame : decryptFrame;
  readable
    .pipeThrough(new TransformStream({ transform: (frame, controller) => fn(frame, controller, ep) }))
    .pipeTo(writable)
    .catch(() => undefined);
}

self.onrtctransform = (event) => {
  const t = event.transformer;
  const o = t.options || {};
  if ((o.op === 'encrypt' || o.op === 'decrypt') && typeof o.ep === 'string') pipe(t.readable, t.writable, o.op, o.ep);
};

self.onmessage = (event) => {
  const m = event.data || {};
  if (m.type === 'key' && m.key instanceof ArrayBuffer && m.key.byteLength === 32) {
    callKey = m.key;
    keys = new Map();
  } else if (m.type === 'streams' && (m.op === 'encrypt' || m.op === 'decrypt') && typeof m.ep === 'string') {
    pipe(m.readable, m.writable, m.op, m.ep);
  } else if (m.type === 'stats') {
    self.postMessage({ type: 'stats', enc: stats.enc, dec: stats.dec, fail: stats.fail });
  }
};
