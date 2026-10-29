// Low-bandwidth calls (docs/v2/04-calls.md §11): the quality controller's tier decisions with hysteresis
// (driven by synthetic stats), Opus SDP tuning, codec order, TURN-over-TLS survival in the ICE filter and
// the new signalling fields. Run: npx vitest run src/lib/calls
import { describe, expect, it } from 'vitest';
import { generateIdentity, newSymmetricKey } from '@kithwall/crypto';
import {
  AUDIO_STEPS, deltaLoss, DOWN_HOLD, ENTER, HEADROOM, MAX_UP_HOLD, START_UP_HOLD, TIERS, meshCeiling, PAUSED, QualityController, SAVER_AUDIO, shareUplink, startTier, STAY, UP_HOLD, videoEncoding,
  type NetSample,
} from './quality';
import { audioPayloadOrder, capVideoBandwidth, firstAudioCodec, isMobileUa, orderAudioCodecs, orderVideoCodecs, tuneOpus, videoStartBitrate } from './sdp';
import { cleanIceServers, hasTurn } from './ice';
import { endpointOf, openSignal, sealSignal } from './signal';

const good = (over: Partial<NetSample> = {}): NetSample => ({ availableOut: 2_000_000, rtt: 0.08, loss: 0, limitation: 'none', ...over });
const run = (c: QualityController, s: NetSample, n: number) => { let d = c.update(s); for (let i = 1; i < n; i++) d = c.update(s); return d; };

describe('quality controller: video tiers', () => {
  it('starts at 360p, earns 720p after a couple of good samples (the first step of a call is quick)', () => {
    const c = new QualityController({ ceiling: 0, saver: false });
    expect(c.tier).toBe(1);
    for (let i = 0; i < START_UP_HOLD - 1; i++) expect(c.update(good()).tier).toBe(1);
    expect(c.update(good()).tier).toBe(0);
    expect(c.quality).toBe('good');
  });

  it('steps down 720p → 360p → 180p → paused as the uplink shrinks, needing two bad samples each time', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 0);
    expect(c.update(good({ availableOut: 500_000 })).tier).toBe(0); // one bad sample: hold
    expect(c.update(good({ availableOut: 500_000 })).tier).toBe(1); // second: down
    expect(run(c, good({ availableOut: 200_000 }), DOWN_HOLD).tier).toBe(2);
    expect(run(c, good({ availableOut: 70_000 }), DOWN_HOLD).tier).toBe(PAUSED);
    expect(c.quality).toBe('fair'); // the bars change only after two samples agree …
    c.update(good({ availableOut: 70_000 }));
    expect(c.quality).toBe('poor'); // … then they do
    expect(c.reason).toBe('bandwidth');
  });

  it('drops straight to the tier that fits, and at once when the link collapses', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 0);
    expect(c.update(good({ availableOut: 120_000 })).tier).toBe(2); // < half of what 720p needs: dire, no wait
    expect(new QualityController({ ceiling: 0, saver: false }, 1).update(good({ availableOut: 60_000 })).tier).toBe(PAUSED);
    const c2 = new QualityController({ ceiling: 0, saver: false }, 0);
    expect(run(c2, good({ availableOut: 150_000 }), 2).tier).toBe(2);
  });

  it('pauses video on heavy loss and steps down one tier on moderate loss or long delay', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 1);
    expect(run(c, good({ loss: 0.12 }), 2).tier).toBe(2);
    expect(c.reason).toBe('loss');
    expect(run(c, good({ loss: 0.4 }), 1).tier).toBe(PAUSED);
    const d = new QualityController({ ceiling: 0, saver: false }, 1);
    expect(run(d, good({ rtt: 1.4 }), 2).tier).toBe(2);
    expect(d.quality).toBe('poor');
    expect(d.reason).toBe('latency');
  });

  it('hysteresis: needs clearly more bandwidth to go up than to stay', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 1);
    const headroom = HEADROOM * (TIERS[1]!.maxBitrate + 32_000);
    const between = (STAY[0]! + headroom) / 2;
    expect(between).toBeGreaterThan(STAY[0]!);
    // Enough to stay at 720p but not a clear sign of room above 360p: stays at 360p.
    expect(run(c, good({ availableOut: between }), 30).tier).toBe(1);
    // The estimate shows headroom (Chrome probes up to ~2× what the encoder may send): up to 720p.
    expect(run(c, good({ availableOut: headroom + 10_000 }), UP_HOLD).tier).toBe(0);
    // And now the in-between value keeps it at 720p (no flapping).
    expect(run(c, good({ availableOut: between }), 30).tier).toBe(0);
  });

  it('a capped encoder can still earn the next tier (the estimate never reaches ENTER from below)', () => {
    // 180p is capped at 140 kbps; the estimate settles well under ENTER[1] but shows headroom.
    const c = new QualityController({ ceiling: 0, saver: false }, 2);
    const est = Math.ceil(HEADROOM * (TIERS[2]!.maxBitrate + 32_000));
    expect(est).toBeLessThan(ENTER[1]!);
    expect(run(c, good({ availableOut: est }), START_UP_HOLD).tier).toBe(1);
  });

  it('recovers from paused by itself once the link is calm (probing the lowest tier first)', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 2);
    run(c, good({ availableOut: 40_000, loss: 0.3 }), 2);
    expect(c.tier).toBe(PAUSED);
    // Calm, but the estimate stays low while almost nothing is sent: still allowed to probe 180p.
    const d = run(c, good({ availableOut: STAY[2]! + 1_000 }), UP_HOLD);
    expect(d.tier).toBe(2);
    expect(run(c, good({ availableOut: 1_500_000 }), UP_HOLD).tier).toBe(1);
    expect(run(c, good({ availableOut: 1_500_000 }), UP_HOLD).tier).toBe(0);
  });

  it('backs off exponentially when upgrades keep failing', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 2);
    const holds: number[] = [];
    for (let round = 0; round < 5; round++) {
      run(c, good({ availableOut: 600_000 }), c.upHold); // earns 360p …
      expect(c.tier).toBe(1);
      run(c, good({ availableOut: 150_000 }), DOWN_HOLD); // … which immediately fails
      expect(c.tier).toBe(2);
      holds.push(c.upHold);
    }
    expect(holds).toEqual([UP_HOLD, 8, 16, MAX_UP_HOLD, MAX_UP_HOLD]);
    // A long calm spell forgives.
    run(c, good({ availableOut: 300_000 }), 70);
    expect(c.upHold).toBeLessThan(MAX_UP_HOLD);
  });

  it('never goes above the ceiling (data saver, receiver wish, mesh) and applies a new ceiling at once', () => {
    const c = new QualityController({ ceiling: 2, saver: true });
    expect(c.tier).toBe(2);
    expect(run(c, good(), 40).tier).toBe(2);
    expect(c.quality).toBe('good'); // capped by choice, not by the network
    expect(c.configure({ ceiling: PAUSED }).tier).toBe(PAUSED); // "voice only"
    expect(c.update(good()).quality).toBe('good');
    expect(c.configure({ ceiling: 0, saver: false }).tier).toBe(2); // lifted: back to the smallest video, then earn the rest
    expect(run(c, good(), START_UP_HOLD).tier).toBe(1);
  });

  it('CPU-limited encoders step down too (cheap phones)', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 0);
    expect(run(c, good({ limitation: 'cpu' }), 2).tier).toBe(1);
    expect(c.reason).toBe('cpu');
    expect(run(c, good({ limitation: 'cpu' }), 2).tier).toBe(2);
    expect(run(c, good({ limitation: 'cpu' }), 10).tier).toBe(2); // CPU alone never pauses video
  });

  it('a single bad sample does not change the tier or the quality shown', () => {
    const c = new QualityController({ ceiling: 0, saver: false }, 1);
    c.update(good());
    expect(c.update(good({ loss: 0.2, availableOut: 200_000 })).tier).toBe(1);
    expect(c.quality).toBe('good');
    expect(c.update(good()).tier).toBe(1);
    expect(c.quality).toBe('good');
  });
});

describe('quality controller: audio and RED', () => {
  it('keeps Opus at 32 kbps on a good link and squeezes it only when video is already gone', () => {
    const c = new QualityController({ ceiling: 0, saver: false });
    expect(run(c, good(), 3).audioBitrate).toBe(32_000);
    expect(run(c, good({ availableOut: 150_000 }), 2).audioBitrate).toBe(24_000);
    expect(run(c, good({ availableOut: 50_000 }), 2).audioBitrate).toBe(12_000);
    expect(run(c, good({ availableOut: 20_000 }), 1).audioBitrate).toBe(8_000);
    expect(c.tier).toBe(PAUSED);
    // Back up one step at a time, slowly.
    expect(run(c, good({ availableOut: 1_000_000 }), UP_HOLD).audioBitrate).toBe(12_000);
    expect(run(c, good({ availableOut: 1_000_000 }), UP_HOLD).audioBitrate).toBe(16_000);
    expect(AUDIO_STEPS[AUDIO_STEPS.length - 1]).toBe(8_000);
  });

  it('data saver caps Opus at 12 kbps', () => {
    const c = new QualityController({ ceiling: 2, saver: true });
    expect(c.audioBitrate).toBe(SAVER_AUDIO);
    expect(run(c, good(), 20).audioBitrate).toBe(SAVER_AUDIO);
    const d = new QualityController({ ceiling: 0, saver: false });
    run(d, good(), 3);
    expect(d.configure({ saver: true }).audioBitrate).toBe(SAVER_AUDIO);
  });

  it('turns RED on under sustained loss when there is room, and off when loss clears or room runs out', () => {
    const c = new QualityController({ ceiling: 0, saver: false });
    expect(c.update(good({ loss: 0.09 })).red).toBe(false);
    expect(c.update(good({ loss: 0.09 })).red).toBe(true);
    expect(run(c, good({ loss: 0.05 }), 10).red).toBe(true); // still lossy-ish: keep it
    expect(run(c, good({ loss: 0 }), UP_HOLD).red).toBe(false);
    run(c, good({ loss: 0.2 }), 2);
    expect(c.red).toBe(true);
    expect(c.update(good({ loss: 0.2, availableOut: 20_000 })).red).toBe(false); // no room even for double 8 kbps audio
  });

  it('data saver uses RED only under heavy loss', () => {
    const c = new QualityController({ ceiling: 2, saver: true });
    expect(run(c, good({ loss: 0.1 }), 4).red).toBe(false);
    expect(run(c, good({ loss: 0.18 }), 2).red).toBe(true);
  });
});

describe('quality helpers', () => {
  it('start tier from the Network Information API', () => {
    expect(startTier(null, false)).toBe(1);
    expect(startTier({ effectiveType: '4g' }, false)).toBe(1);
    expect(startTier({ effectiveType: '2g' }, false)).toBe(2);
    expect(startTier({ effectiveType: '4g', saveData: true }, false)).toBe(2);
    expect(startTier(null, true)).toBe(2);
  });

  it('mesh: fewer pixels per peer as the call grows, and a fair share of the uplink each', () => {
    expect([1, 2, 3, 4, 7].map(meshCeiling)).toEqual([0, 1, 1, 2, 2]);
    expect(shareUplink([900_000])).toEqual([900_000]);
    expect(shareUplink([900_000, 300_000, null])).toEqual([400_000, 300_000, null]);
  });

  it('video encodings per tier', () => {
    expect(videoEncoding(0, 720, null)).toEqual({ active: true, scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 });
    expect(videoEncoding(1, 720, null)).toMatchObject({ scaleResolutionDownBy: 2, maxFramerate: 24 });
    expect(videoEncoding(2, 360, null)).toMatchObject({ scaleResolutionDownBy: 2, maxFramerate: 15, maxBitrate: 140_000 });
    expect(videoEncoding(1, 360, 300_000)).toMatchObject({ scaleResolutionDownBy: 1, maxBitrate: 255_000 });
    expect(videoEncoding(PAUSED, 720, null).active).toBe(false);
    expect(videoEncoding(0, 0, null).scaleResolutionDownBy).toBe(1);
  });
});

// A trimmed Chrome offer.
const OFFER = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sendrecv',
  'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000', 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:13 CN/8000', 'a=rtpmap:110 telephone-event/48000', 'a=rtpmap:126 telephone-event/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=sendrecv', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96', '',
].join('\r\n');

describe('Opus SDP tuning', () => {
  it('adds FEC, DTX, mono and a bitrate ceiling to the Opus fmtp, leaving everything else alone', () => {
    const out = tuneOpus(OFFER, { maxAverageBitrate: 32_000 });
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000\r\n');
    expect(out.split('\r\n').filter((l) => !l.startsWith('a=fmtp:111'))).toEqual(OFFER.split('\r\n').filter((l) => !l.startsWith('a=fmtp:111')));
    expect(out.endsWith('\r\n')).toBe(true);
    expect(audioPayloadOrder(out)).toEqual(['111', '63', '9', '0', '8', '13', '110', '126']);
    expect(firstAudioCodec(out)).toBe('opus');
    expect(firstAudioCodec(out.replace('SAVPF 111 63 ', 'SAVPF 63 111 '))).toBe('red');
    expect(firstAudioCodec('v=0\r\n')).toBeNull();
  });

  it('is idempotent and overrides earlier values (cbr dropped, ceiling clamped)', () => {
    const once = tuneOpus(OFFER.replace('useinbandfec=1', 'useinbandfec=0;cbr=1;maxaveragebitrate=64000'), { maxAverageBitrate: 2_000 });
    expect(once).toContain('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=6000;usedtx=1;stereo=0;sprop-stereo=0\r\n');
    expect(once).not.toContain('cbr');
    expect(tuneOpus(once, { maxAverageBitrate: 2_000 })).toBe(once);
  });

  it('sets a packet time for very slow links (fewer packets, less header overhead)', () => {
    const out = tuneOpus(OFFER, { maxAverageBitrate: 12_000, ptime: 60 });
    const audio = out.split('m=video')[0]!;
    expect(audio).toContain('a=ptime:60\r\na=maxptime:120\r\n');
    expect(out.split('m=video')[1]).not.toContain('ptime');
    expect(tuneOpus(out, { maxAverageBitrate: 12_000, ptime: 60 }).match(/a=ptime/g)).toHaveLength(1);
    expect(tuneOpus(OFFER, { maxAverageBitrate: 12_000, ptime: 33 })).not.toContain('a=ptime');
  });

  it('creates the fmtp line when the offer has none, and ignores SDPs without Opus', () => {
    const bare = OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    expect(tuneOpus(bare, { maxAverageBitrate: 16_000 })).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=16000\r\n');
    const noOpus = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
    expect(tuneOpus(noOpus, { maxAverageBitrate: 16_000 })).toBe(noOpus);
  });

  it('test knob: caps the video section bandwidth only', () => {
    const out = capVideoBandwidth(OFFER, 120);
    expect(out.split('m=video')[1]).toContain('c=IN IP4 0.0.0.0\r\nb=AS:120\r\nb=TIAS:120000\r\n');
    expect(out.split('m=video')[0]).not.toContain('b=AS');
    expect(capVideoBandwidth(out, 80).match(/b=AS/g)).toHaveLength(1);
  });
});

describe('codec order', () => {
  const c = (mimeType: string, sdpFmtpLine?: string) => ({ mimeType, clockRate: mimeType.startsWith('audio') ? 48000 : 90000, sdpFmtpLine });
  const AUDIO = [c('audio/opus'), c('audio/red'), c('audio/G722'), c('audio/PCMU'), c('audio/CN'), { mimeType: 'audio/CN', clockRate: 8000 }, c('audio/telephone-event')];
  const VIDEO = [c('video/VP8'), c('video/rtx'), c('video/VP9'), c('video/H264', 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f'),
    c('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f'), c('video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'),
    c('video/AV1'), c('video/H265'), c('video/red'), c('video/ulpfec')];

  it('audio: Opus, then RED (negotiated but not used until needed), then CN / DTMF; legacy codecs dropped', () => {
    expect(orderAudioCodecs(AUDIO).map((x) => x.mimeType)).toEqual(['audio/opus', 'audio/red', 'audio/CN', 'audio/telephone-event']);
    expect(orderAudioCodecs([c('audio/PCMU')])).toEqual([c('audio/PCMU')]);
    // RED switched on (by renegotiating): RED leads, which is what makes Chrome send it.
    expect(orderAudioCodecs(AUDIO, true).map((x) => x.mimeType)).toEqual(['audio/red', 'audio/opus', 'audio/CN', 'audio/telephone-event']);
    expect(orderAudioCodecs([c('audio/opus')], true).map((x) => x.mimeType)).toEqual(['audio/opus']);
  });

  it('video with frame encryption: VP8 only (+ RTX/FEC)', () => {
    expect(orderVideoCodecs(VIDEO, { frames: true, mobile: true }).map((x) => x.mimeType)).toEqual(['video/VP8', 'video/rtx', 'video/red', 'video/ulpfec']);
  });

  it('video without frame encryption: hardware H.264 first on phones, VP8 first on desktops, never AV1/H.265', () => {
    const phone = orderVideoCodecs(VIDEO, { frames: false, mobile: true });
    expect(phone[0]!.sdpFmtpLine).toContain('packetization-mode=1;profile-level-id=42e01f');
    expect(phone.map((x) => x.mimeType)).toEqual(['video/H264', 'video/H264', 'video/H264', 'video/VP8', 'video/VP9', 'video/rtx', 'video/red', 'video/ulpfec']);
    expect(orderVideoCodecs(VIDEO, { frames: false, mobile: false }).map((x) => x.mimeType).slice(0, 3)).toEqual(['video/VP8', 'video/VP9', 'video/H264']);
  });

  it('mobile detection', () => {
    expect(isMobileUa('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36')).toBe(true);
    expect(isMobileUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36')).toBe(false);
  });
});

describe('TURN for restrictive networks', () => {
  it("keeps Cloudflare's TURN over TCP and TLS on 443 (and 80); drops port 53", () => {
    // The shape Cloudflare's generate-ice-servers endpoint documents.
    const cf = { iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp',
        'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'u', credential: 'c' },
    ] };
    const out = cleanIceServers(cf);
    const urls = out.flatMap((s) => s.urls as string[]);
    expect(urls).toContain('turns:turn.cloudflare.com:443?transport=tcp');
    expect(urls).toContain('turn:turn.cloudflare.com:80?transport=tcp');
    expect(urls).toContain('turn:turn.cloudflare.com:3478?transport=tcp');
    expect(urls.some((u) => /:53\b/.test(u))).toBe(false);
    expect(hasTurn(out)).toBe(true);
  });
});

describe('signalling: low-bandwidth fields', () => {
  const ANN = '00000000-0000-4000-8000-00000000a001';
  const CONV = { id: '11111111-1111-4111-8111-111111111111', audienceId: '22222222-2222-4222-8222-222222222222' };
  const ann = generateIdentity();
  const key = newSymmetricKey();
  const open = (body: unknown) => openSignal(
    sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal: { call: '33333333-3333-4333-8333-333333333333', from: endpointOf(ANN, 'devAnn01'), ts: Date.now(), body: body as never } }),
    { conv: CONV, keyFor: () => key, members: [{ id: ANN, signPub: ann.signPub }] });

  it('accepts state with net / vp / rx, and the restart / renegotiate requests', () => {
    expect(open({ k: 'state', mic: true, cam: false }).ok).toBe(true);
    expect(open({ k: 'state', mic: true, cam: true, net: 2, vp: true, rx: 3 }).ok).toBe(true);
    expect(open({ k: 'restart' }).ok).toBe(true);
    expect(open({ k: 'reneg' }).ok).toBe(true);
    expect(open({ k: 'reneg', red: true }).ok).toBe(true);
    expect(open({ k: 'reneg', red: 1 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects out-of-range values', () => {
    expect(open({ k: 'state', mic: true, cam: true, net: 3 })).toEqual({ ok: false, reason: 'malformed' });
    expect(open({ k: 'state', mic: true, cam: true, rx: 1.5 })).toEqual({ ok: false, reason: 'malformed' });
    expect(open({ k: 'state', mic: true, cam: true, vp: 'yes' })).toEqual({ ok: false, reason: 'malformed' });
  });
  it('trickle ICE: cumulative, bounded candidate lists; ringing; the tr flags', () => {
    const cand = 'candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host generation 0';
    expect(open({ k: 'cand', u: 'AbC+/123', c: [['0', 0, cand]] }).ok).toBe(true);
    expect(open({ k: 'cand', u: 'AbC1', c: [], done: true }).ok).toBe(true);
    expect(open({ k: 'ringing' }).ok).toBe(true);
    expect(open({ k: 'join', fe: true, video: false, tr: true }).ok).toBe(true);
    expect(open({ k: 'offer', sdp: 'v=0', fe: true, tr: true }).ok).toBe(true);
    // Malformed: bad ufrag, not a candidate line, injected line break, too many, bad index, bad flags.
    expect(open({ k: 'cand', u: 'a b', c: [['0', 0, cand]] }).ok).toBe(false);
    expect(open({ k: 'cand', u: 'AbC1', c: [['0', 0, 'a=fingerprint:x']] }).ok).toBe(false);
    expect(open({ k: 'cand', u: 'AbC1', c: [['0', 0, cand + String.fromCharCode(13, 10) + 'a=evil']] }).ok).toBe(false);
    expect(open({ k: 'cand', u: 'AbC1', c: Array.from({ length: 65 }, () => ['0', 0, cand]) }).ok).toBe(false);
    expect(open({ k: 'cand', u: 'AbC1', c: [['0', 99, cand]] }).ok).toBe(false);
    expect(open({ k: 'cand', u: 'AbC1', c: [['0', 0, cand]], done: 'yes' }).ok).toBe(false);
    expect(open({ k: 'join', fe: true, video: false, tr: 1 }).ok).toBe(false);
  });
});

describe('call start-up', () => {
  it('asks the other side to start video at a sensible bitrate, on every video codec, without touching audio', () => {
    const NL = String.fromCharCode(13, 10);
    const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
      'a=rtpmap:98 H264/90000', 'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', ''].join(NL);
    const out = videoStartBitrate(sdp, 800);
    expect(out).toContain(`a=rtpmap:96 VP8/90000${NL}a=fmtp:96 x-google-start-bitrate=800`);
    expect(out).toContain('a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=800');
    expect(out).toContain(`a=fmtp:97 apt=96${NL}`);
    expect(out).toContain(`a=fmtp:111 minptime=10;useinbandfec=1${NL}`);
    // Idempotent and clamped.
    expect(videoStartBitrate(out, 800)).toBe(out);
    expect(videoStartBitrate(sdp, 99_999)).toContain('x-google-start-bitrate=2000');
  });

  it('lists UDP relays first, then TCP, then TLS', () => {
    const out = cleanIceServers({ iceServers: [{ urls: ['turns:t.example:443?transport=tcp', 'turn:t.example:80?transport=tcp', 'turn:t.example:3478?transport=udp', 'stun:t.example:3478'], username: 'u', credential: 'c' }] });
    expect(out[0]!.urls).toEqual(['stun:t.example:3478', 'turn:t.example:3478?transport=udp', 'turn:t.example:80?transport=tcp', 'turns:t.example:443?transport=tcp']);
  });
});

describe('deltaLoss (outbound loss from cumulative counters)', () => {
  it('measures loss since the last sample, not a stale fraction', () => {
    expect(deltaLoss({ audio: 100, video: 400 }, { audio: 0, video: 40 }, { audio: 50, video: 200 }, { audio: 0, video: 0 })).toBeCloseTo(40 / 240);
  });
  it('treats a paused or silent stream (no new packets / no new reports) as clean', () => {
    expect(deltaLoss({ audio: 150, video: 400 }, { audio: 2, video: 40 }, { audio: 100, video: 400 }, { audio: 2, video: 40 })).toBe(0);
    expect(deltaLoss({ audio: 105 }, { audio: 5 }, { audio: 100 }, { audio: 0 })).toBe(0); // too few packets to judge
  });
});
