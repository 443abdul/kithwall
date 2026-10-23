// SDP and codec tuning for slow, lossy networks (docs/v2/04-calls.md §11 "Low bandwidth"). Pure: no
// WebRTC objects, so vitest can check every rule.
//
// What the fmtp line of an SDP says is "how I want to RECEIVE": the other browser's Opus encoder reads
// useinbandfec / usedtx / stereo / maxaveragebitrate / ptime from the description it gets from us. So we
// tune only the SDP we SEND (the offer / answer inside the sealed signal) and leave our own local
// description untouched: nothing to break in setLocalDescription, the DTLS fingerprint (and so the
// safety code) is unchanged, and an older client that doesn't tune still gets a valid SDP.

export interface OpusTuning {
  /** Ceiling for the other side's Opus encoder (bps, clamped 6000–510000). Live changes go through setParameters. */
  maxAverageBitrate: number;
  /** Packet duration we'd like to receive (ms). 20 normally; 40/60 on very slow links: fewer packets, much less header overhead. */
  ptime?: number;
}

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000(?:\/2)?$/im;

function splitSections(sdp: string): { head: string[]; media: string[][] } {
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const head: string[] = [];
  const media: string[][] = [];
  for (const l of lines) {
    if (l.startsWith('m=')) media.push([l]);
    else if (media.length) media[media.length - 1]!.push(l);
    else head.push(l);
  }
  return { head, media };
}

const join = (head: string[], media: string[][]) => [...head, ...media.flat()].join('\r\n') + '\r\n';

function parseFmtp(params: string): [string, string][] {
  return params.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
}

/**
 * Opus for bad networks: in-band FEC (recovers a lost packet from the next one), DTX (almost nothing is
 * sent while you're silent), mono, a bitrate ceiling, and a packet time. Applies to every audio section
 * that carries Opus; anything else in the SDP is left byte-for-byte alone.
 */
export function tuneOpus(sdp: string, t: OpusTuning): string {
  const { head, media } = splitSections(sdp);
  const rate = Math.round(Math.min(510_000, Math.max(6_000, t.maxAverageBitrate)));
  const ptime = t.ptime && [10, 20, 40, 60].includes(t.ptime) ? t.ptime : null;
  for (const sec of media) {
    if (!sec[0]!.startsWith('m=audio')) continue;
    const pt = OPUS_RTPMAP.exec(sec.join('\n'))?.[1];
    if (!pt) continue;
    const want: Record<string, string> = { useinbandfec: '1', usedtx: '1', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: String(rate) };
    const fi = sec.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (fi >= 0) {
      const params = parseFmtp(sec[fi]!.slice(`a=fmtp:${pt} `.length)).filter(([k]) => k !== 'cbr');
      for (const [k, v] of Object.entries(want)) {
        const at = params.findIndex(([pk]) => pk === k);
        if (at >= 0) params[at] = [k, v]; else params.push([k, v]);
      }
      sec[fi] = `a=fmtp:${pt} ` + params.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
    } else {
      const ri = sec.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      sec.splice(ri + 1, 0, `a=fmtp:${pt} minptime=10;` + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';'));
    }
    if (ptime) {
      for (let i = sec.length - 1; i >= 0; i--) if (/^a=(max)?ptime:/.test(sec[i]!)) sec.splice(i, 1);
      sec.push(`a=ptime:${ptime}`, 'a=maxptime:120');
    }
  }
  return join(head, media);
}

/**
 * Test knob (debug builds of a call only): advertise a receive-bandwidth cap for video (b=AS / b=TIAS),
 * so the other side's congestion controller really is held under it. Used by the browser tests to
 * check that the quality controller steps video down and pauses it under a real constraint.
 */
export function capVideoBandwidth(sdp: string, kbps: number): string {
  const { head, media } = splitSections(sdp);
  const k = Math.max(16, Math.round(kbps));
  for (const sec of media) {
    if (!sec[0]!.startsWith('m=video')) continue;
    for (let i = sec.length - 1; i >= 0; i--) if (/^b=(AS|TIAS):/.test(sec[i]!)) sec.splice(i, 1);
    const ci = sec.findIndex((l) => l.startsWith('c='));
    sec.splice(ci >= 0 ? ci + 1 : 1, 0, `b=AS:${k}`, `b=TIAS:${k * 1000}`);
  }
  return join(head, media);
}

/** The payload types advertised for audio, in order. */
export function audioPayloadOrder(sdp: string): string[] {
  const m = /^m=audio \d+ [A-Z/]+ ([\d ]+)\r?$/m.exec(sdp);
  return m ? m[1]!.trim().split(/\s+/) : [];
}

/** The first (= preferred, = sent) audio codec's name, lower case ('opus', 'red', …), or null. */
export function firstAudioCodec(sdp: string): string | null {
  const pt = audioPayloadOrder(sdp)[0];
  if (!pt) return null;
  const m = new RegExp(`^a=rtpmap:${pt} ([A-Za-z0-9-]+)/`, 'm').exec(sdp);
  return m ? m[1]!.toLowerCase() : null;
}

// ------------------------------------------------------------------------------------- codec order

export interface CodecCap { mimeType: string; clockRate: number; channels?: number; sdpFmtpLine?: string }

const AUX_VIDEO = /^video\/(rtx|red|ulpfec|flexfec-03)$/i;

/**
 * Audio: Opus first (with FEC/DTX it is the codec for bad networks), then RED (audio redundancy) so it is
 * negotiated; with `redFirst` RED leads, which is what makes Chrome send it (switched on by renegotiating
 * when loss is high: engine.ts maybeRenegotiate). Then the rest
 * (comfort noise, DTMF). Codecs nobody needs (G.722, PCMU/PCMA, iLBC) are dropped: a smaller SDP is a
 * smaller signalling message.
 */
export function orderAudioCodecs<T extends CodecCap>(codecs: T[], redFirst = false): T[] {
  const opus = codecs.filter((c) => /^audio\/opus$/i.test(c.mimeType));
  if (!opus.length) return codecs;
  const red = codecs.filter((c) => /^audio\/red$/i.test(c.mimeType));
  const rest = codecs.filter((c) => /^audio\/(cn|telephone-event)$/i.test(c.mimeType) && c.clockRate === 48000);
  return redFirst && red.length ? [...red, ...opus, ...rest] : [...opus, ...red, ...rest];
}

/**
 * Video, kept simple and robust for cheap phones:
 *  - frame encryption on: VP8 only. Its frame header is what the encryption worker keeps in the clear;
 *    H.264/AV1 packetisers parse the bitstream and would break on encrypted frames.
 *  - otherwise, phones: H.264 first (hardware encoder: far less CPU and battery), then VP8, VP9.
 *  - otherwise, desktops: VP8, VP9, H.264.
 * AV1 and H.265 are left out: software AV1 is too heavy for low-end phones, and H.265 support is patchy.
 * RTX (retransmission) and RED/ULPFEC (video FEC) are kept: they help on lossy links.
 */
export function orderVideoCodecs<T extends CodecCap>(codecs: T[], opts: { frames: boolean; mobile: boolean }): T[] {
  const by = (re: RegExp) => codecs.filter((c) => re.test(c.mimeType));
  const vp8 = by(/^video\/vp8$/i);
  const vp9 = by(/^video\/vp9$/i);
  // Constrained baseline with packetization-mode=1 first: the profile every hardware encoder has.
  const h264 = by(/^video\/h264$/i).sort((a, b) => h264Rank(a) - h264Rank(b));
  const aux = codecs.filter((c) => AUX_VIDEO.test(c.mimeType));
  if (opts.frames) return vp8.length ? [...vp8, ...aux] : codecs;
  const main = opts.mobile ? [...h264, ...vp8, ...vp9] : [...vp8, ...vp9, ...h264];
  return main.length ? [...main, ...aux] : codecs;
}

function h264Rank(c: CodecCap): number {
  const f = c.sdpFmtpLine ?? '';
  const mode1 = /packetization-mode=1/.test(f) ? 0 : 2;
  const baseline = /profile-level-id=42e0/i.test(f) ? 0 : /profile-level-id=42/i.test(f) ? 1 : 4;
  return mode1 + baseline;
}

/** Rough "is this a phone/tablet" check, only used to prefer hardware H.264. */
export function isMobileUa(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

/**
 * Where the other side's video encoder starts (`x-google-start-bitrate`, kbps, on every video codec's fmtp
 * line in the SDP we SEND: like the Opus parameters, it configures the other side's sender). Chrome's
 * bandwidth estimate otherwise starts around 300 kbps and climbs for several seconds, so a call on a good
 * link looks blurry at first. Not used on slow links or with data saver (there the default start is right).
 * Other browsers ignore it.
 */
export function videoStartBitrate(sdp: string, kbps: number): string {
  const { head, media } = splitSections(sdp);
  const k = Math.round(Math.min(2_000, Math.max(100, kbps)));
  for (const sec of media) {
    if (!sec[0]!.startsWith('m=video')) continue;
    const pts = sec.map((l) => /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\/90000/i.exec(l)?.[1]).filter((x): x is string => !!x);
    for (const pt of pts) {
      const fi = sec.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
      if (fi >= 0) {
        const params = parseFmtp(sec[fi]!.slice(`a=fmtp:${pt} `.length)).filter(([n]) => n !== 'x-google-start-bitrate');
        params.push(['x-google-start-bitrate', String(k)]);
        sec[fi] = `a=fmtp:${pt} ` + params.map(([n, v]) => (v === '' ? n : `${n}=${v}`)).join(';');
      } else {
        const ri = sec.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
        sec.splice(ri + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${k}`);
      }
    }
  }
  return join(head, media);
}
