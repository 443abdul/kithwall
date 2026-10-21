// Calls (docs/v2/04-calls.md): sealed signalling, the state machine, the safety code and ICE server
// filtering. Run: npx vitest run src/lib/calls
import { describe, expect, it } from 'vitest';
import { generateIdentity, newSymmetricKey } from '@kithwall/crypto';
import { endpointOf, isWire, MAX_SIGNAL_AGE_MS, openSignal, parseEndpoint, sealSignal, SeenIds, type Signal } from './signal';
import { IDLE, isLive, step, type MachineEvent, type MachineState } from './machine';
import { callSafetyCode, sdpFingerprint, SAFETY_EMOJI } from './safety';
import { cleanIceServers, hasTurn } from './ice';

const ANN = '00000000-0000-4000-8000-00000000a001';
const BEN = '00000000-0000-4000-8000-00000000b002';
const EVE = '00000000-0000-4000-8000-00000000e003';
const CONV = { id: '11111111-1111-4111-8111-111111111111', audienceId: '22222222-2222-4222-8222-222222222222' };
const CALL = '33333333-3333-4333-8333-333333333333';

const ann = generateIdentity();
const ben = generateIdentity();
const eve = generateIdentity();
const key = newSymmetricKey();
const members = [{ id: ANN, signPub: ann.signPub }, { id: BEN, signPub: ben.signPub }];

function sig(body: Signal['body'], over: Partial<Signal> = {}): Signal {
  return { call: CALL, from: endpointOf(ANN, 'devAnn01'), ts: Date.now(), body, ...over };
}

describe('sealed signalling', () => {
  it('round-trips and identifies the author without putting it on the wire', () => {
    const wire = sealSignal({ conv: CONV, epoch: 3, key, signPriv: ann.signPriv, author: ANN, signal: sig({ k: 'offer', sdp: 'v=0\r\n', fe: true }) });
    expect(isWire(wire)).toBe(true);
    const text = JSON.stringify(wire);
    expect(text).not.toContain(ANN);
    expect(text).not.toContain('offer');
    expect(text).not.toContain('v=0');
    expect(Object.keys(wire).sort()).toEqual(['e', 'env', 'i', 'v']);
    const r = openSignal(wire, { conv: CONV, keyFor: (e) => (e === 3 ? key : null), members });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.author).toBe(ANN);
      expect(r.signal.body).toEqual({ k: 'offer', sdp: 'v=0\r\n', fe: true });
    }
  });

  it('carries the conversation id only on the ring topic', () => {
    const wire = sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal: sig({ k: 'ring', video: true, key: 'A'.repeat(43) }), withConv: true });
    expect(wire.c).toBe(CONV.id);
    expect(openSignal(wire, { conv: { ...CONV, id: '44444444-4444-4444-8444-444444444444' }, keyFor: () => key, members }).ok).toBe(false);
  });

  it('rejects a non-member, a forged author, the wrong key, tampering and another conversation', () => {
    const byEve = sealSignal({ conv: CONV, epoch: 1, key, signPriv: eve.signPriv, author: EVE, signal: sig({ k: 'leave' }, { from: endpointOf(EVE, 'devEve01') }) });
    expect(openSignal(byEve, { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'unverified' });

    // Ben signs, but claims to be Ann's device inside.
    const spoof = sealSignal({ conv: CONV, epoch: 1, key, signPriv: ben.signPriv, author: BEN, signal: sig({ k: 'leave' }) });
    expect(openSignal(spoof, { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'mismatch' });

    const good = sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal: sig({ k: 'leave' }) });
    expect(openSignal(good, { conv: CONV, keyFor: () => newSymmetricKey(), members }).ok).toBe(false);
    expect(openSignal(good, { conv: CONV, keyFor: () => null, members })).toEqual({ ok: false, reason: 'no-key' });
    expect(openSignal({ ...good, i: '55555555-5555-4555-8555-555555555555' }, { conv: CONV, keyFor: () => key, members }).ok).toBe(false);
    expect(openSignal({ ...good, e: 2 }, { conv: CONV, keyFor: () => key, members }).ok).toBe(false);
    const other = { id: '66666666-6666-4666-8666-666666666666', audienceId: CONV.audienceId };
    expect(openSignal(good, { conv: other, keyFor: () => key, members }).ok).toBe(false);
    expect(openSignal({ v: 1 }, { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('drops stale signals and malformed bodies', () => {
    const old = sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal: sig({ k: 'probe' }, { ts: Date.now() - MAX_SIGNAL_AGE_MS - 1000 }) });
    expect(openSignal(old, { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'stale' });
    const bad = sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal: sig({ k: 'ring', video: true, key: 'short' }) });
    expect(openSignal(bad, { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('parses endpoints and remembers seen ids', () => {
    expect(parseEndpoint(endpointOf(ANN, 'abcDEF12'))).toEqual({ userId: ANN, dev: 'abcDEF12' });
    expect(parseEndpoint('nope')).toBeNull();
    expect(parseEndpoint(`${ANN}:x`)).toBeNull();
    const seen = new SeenIds();
    expect(seen.add('a')).toBe(true);
    expect(seen.add('a')).toBe(false);
  });
});

describe('call state machine', () => {
  const run = (events: MachineEvent[], from: MachineState = IDLE) => events.reduce(step, from);

  it('1:1 outgoing call connects and ends on hang-up', () => {
    let s = run([{ t: 'place', invited: [BEN] }]);
    expect(s.phase).toBe('outgoing');
    expect(isLive(s.phase)).toBe(true);
    s = step(s, { t: 'peer-connected', count: 1 });
    expect(s).toMatchObject({ phase: 'active', everConnected: true, connected: 1 });
    s = step(s, { t: 'hangup' });
    expect(s).toMatchObject({ phase: 'ended', reason: 'hangup' });
    expect(step(s, { t: 'reset' })).toBe(IDLE);
  });

  it('remote hang-up ends a 1:1 call', () => {
    const s = run([{ t: 'place', invited: [BEN] }, { t: 'peer-connected', count: 1 }, { t: 'peer-left', count: 0 }]);
    expect(s).toMatchObject({ phase: 'ended', reason: 'remote' });
  });

  it('declined, busy and unanswered calls', () => {
    expect(run([{ t: 'place', invited: [BEN] }, { t: 'remote-declined', userId: BEN }])).toMatchObject({ phase: 'ended', reason: 'declined' });
    expect(run([{ t: 'place', invited: [BEN] }, { t: 'remote-declined', userId: BEN, busy: true }])).toMatchObject({ phase: 'ended', reason: 'busy' });
    expect(run([{ t: 'place', invited: [BEN] }, { t: 'timeout' }])).toMatchObject({ phase: 'ended', reason: 'no-answer' });
  });

  it('a group call keeps ringing until everyone declines, and survives one person leaving', () => {
    let s = run([{ t: 'place', invited: [BEN, EVE] }, { t: 'remote-declined', userId: BEN }]);
    expect(s.phase).toBe('outgoing');
    s = step(s, { t: 'remote-declined', userId: EVE });
    expect(s).toMatchObject({ phase: 'ended', reason: 'declined' });
    s = run([{ t: 'place', invited: [BEN, EVE] }, { t: 'peer-connected', count: 1 }, { t: 'peer-connected', count: 2 }, { t: 'peer-left', count: 1 }]);
    expect(s).toMatchObject({ phase: 'active', connected: 1 });
    expect(step(s, { t: 'peer-left', count: 0 })).toMatchObject({ phase: 'ended', reason: 'remote' });
  });

  it('incoming: accept, decline, missed, cancelled, answered elsewhere', () => {
    const ring: MachineEvent = { t: 'ring', invited: [ANN] };
    expect(run([ring, { t: 'accept' }]).phase).toBe('connecting');
    expect(run([ring, { t: 'accept' }, { t: 'peer-connected', count: 1 }]).phase).toBe('active');
    expect(run([ring, { t: 'decline' }])).toMatchObject({ phase: 'ended', reason: 'rejected' });
    expect(run([ring, { t: 'timeout' }])).toMatchObject({ phase: 'ended', reason: 'missed' });
    expect(run([ring, { t: 'cancelled' }])).toMatchObject({ phase: 'ended', reason: 'missed' });
    expect(run([ring, { t: 'answered-elsewhere' }])).toMatchObject({ phase: 'ended', reason: 'elsewhere' });
    expect(run([ring, { t: 'accept' }, { t: 'timeout' }])).toMatchObject({ phase: 'ended', reason: 'failed' });
  });

  it('ignores events that do not apply', () => {
    expect(step(IDLE, { t: 'hangup' })).toBe(IDLE);
    expect(step(IDLE, { t: 'accept' })).toBe(IDLE);
    const active = run([{ t: 'place', invited: [BEN] }, { t: 'peer-connected', count: 1 }]);
    expect(step(active, { t: 'ring', invited: [BEN] })).toBe(active);
    expect(step(active, { t: 'cancelled' })).toBe(active);
    expect(run([{ t: 'place', invited: [BEN] }, { t: 'failed', reason: 'no-media' }])).toMatchObject({ phase: 'ended', reason: 'no-media' });
  });
});

describe('call safety code', () => {
  const sdp = (fp: string) => `v=0\r\na=group:BUNDLE 0 1\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n`;
  it('reads the DTLS fingerprint from SDP', () => {
    expect(sdpFingerprint(sdp('ab:cd:ef'))).toBe('sha-256 AB:CD:EF');
    expect(sdpFingerprint('v=0\r\n')).toBeNull();
  });
  it('is the same on both ends and changes with any input', async () => {
    const a = { userId: ANN, signPub: 'A'.repeat(43), fingerprint: 'sha-256 AA:BB' };
    const b = { userId: BEN, signPub: 'B'.repeat(43), fingerprint: 'sha-256 CC:DD' };
    const x = await callSafetyCode(CALL, a, b);
    const y = await callSafetyCode(CALL, b, a);
    expect(x).toEqual(y);
    expect(x.emoji).toHaveLength(4);
    x.emoji.forEach((e) => expect(SAFETY_EMOJI).toContain(e));
    expect(x.digits).toMatch(/^\d{6}$/);
    const mitm = await callSafetyCode(CALL, a, { ...b, fingerprint: 'sha-256 EE:FF' });
    expect(mitm).not.toEqual(x);
    expect(await callSafetyCode('77777777-7777-4777-8777-777777777777', a, b)).not.toEqual(x);
    expect(new Set(SAFETY_EMOJI).size).toBe(64);
  });
});

describe('ICE servers', () => {
  it('keeps STUN/TURN entries, drops port 53 and junk', () => {
    const out = cleanIceServers({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp', 'http://evil'], username: 'u', credential: 'c' },
        { urls: 'javascript:alert(1)' },
      ],
    });
    expect(out).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    expect(hasTurn(out)).toBe(true);
    expect(hasTurn([out[0]!])).toBe(false);
    expect(cleanIceServers(null)).toEqual([]);
  });
});
