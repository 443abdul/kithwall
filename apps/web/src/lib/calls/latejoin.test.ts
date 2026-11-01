// Late join and in-call devices (docs/v2/04-calls.md §14, §7): the sealed `live` hint, the machine's
// `join` path, who announces a call and to whom, the hint store's expiry, and following devices that are
// plugged in or pulled out. Run: npx vitest run src/lib/calls
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity, newSymmetricKey } from '@kithwall/crypto';
import { endpointOf, openSignal, sealSignal, type Signal } from './signal';
import { IDLE, step, type MachineEvent } from './machine';
import { clearAllLiveCalls, clearLiveCall, getLiveCall, isAnnouncer, LIVE_TTL_MS, liveTargets, setLiveCall } from './live';
import { deviceAfterChange } from './devices';

const ANN = '00000000-0000-4000-8000-00000000a001';
const BEN = '00000000-0000-4000-8000-00000000b002';
const CAT = '00000000-0000-4000-8000-00000000c003';
const DAN = '00000000-0000-4000-8000-00000000d004';
const CONV = { id: '11111111-1111-4111-8111-111111111111', audienceId: '22222222-2222-4222-8222-222222222222' };
const CALL = '33333333-3333-4333-8333-333333333333';
const KEY = 'A'.repeat(43);

const ann = generateIdentity();
const ben = generateIdentity();
const key = newSymmetricKey();
const members = [{ id: ANN, signPub: ann.signPub }, { id: BEN, signPub: ben.signPub }];

function live(body: Partial<Extract<Signal['body'], { k: 'live' }>> = {}) {
  const signal: Signal = { call: CALL, from: endpointOf(ANN, 'devAnn01'), ts: Date.now(), body: { k: 'live', n: 3, video: true, key: KEY, ...body } as Signal['body'] };
  return sealSignal({ conv: CONV, epoch: 1, key, signPriv: ann.signPriv, author: ANN, signal, withConv: true });
}

describe('the live hint', () => {
  it('is sealed like a ring: conversation id only, nothing else readable on the wire', () => {
    const wire = live();
    expect(Object.keys(wire).sort()).toEqual(['c', 'e', 'env', 'i', 'v']);
    const text = JSON.stringify(wire);
    for (const leak of [ANN, CALL, KEY, 'live', 'video']) expect(text).not.toContain(leak);
    const r = openSignal(wire, { conv: CONV, keyFor: () => key, members });
    expect(r.ok && r.signal.body).toEqual({ k: 'live', n: 3, video: true, key: KEY });
  });

  it('accepts n = 0 (the call is over) and refuses nonsense counts or keys', () => {
    expect(openSignal(live({ n: 0 }), { conv: CONV, keyFor: () => key, members }).ok).toBe(true);
    for (const bad of [{ n: -1 }, { n: 1.5 }, { n: 1000 }, { key: 'short' }]) {
      expect(openSignal(live(bad), { conv: CONV, keyFor: () => key, members })).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('only verifies for members of the conversation', () => {
    expect(openSignal(live(), { conv: CONV, keyFor: () => key, members: [members[1]!] })).toEqual({ ok: false, reason: 'unverified' });
  });
});

describe('late join in the state machine', () => {
  const run = (events: MachineEvent[]) => events.reduce(step, IDLE);

  it('join goes straight to connecting, then active like an answered call', () => {
    expect(run([{ t: 'join', invited: [ANN, BEN] }])).toMatchObject({ phase: 'connecting', invited: [ANN, BEN] });
    expect(run([{ t: 'join', invited: [ANN, BEN] }, { t: 'peer-connected', count: 1 }, { t: 'peer-connected', count: 2 }]))
      .toMatchObject({ phase: 'active', connected: 2, everConnected: true });
  });

  it('a call that already ended says so, and join is ignored while in another call', () => {
    expect(run([{ t: 'join', invited: [ANN] }, { t: 'failed', reason: 'over' }])).toMatchObject({ phase: 'ended', reason: 'over' });
    const active = run([{ t: 'place', invited: [BEN] }, { t: 'peer-connected', count: 1 }]);
    expect(step(active, { t: 'join', invited: [CAT] })).toBe(active);
    const ended = step(active, { t: 'hangup' });
    expect(step(ended, { t: 'join', invited: [CAT] }).phase).toBe('connecting');
  });
});

describe('who announces a call, and to whom', () => {
  const a = endpointOf(ANN, 'devAnn01');
  const b = endpointOf(BEN, 'devBen01');
  const c = endpointOf(CAT, 'devCat01');

  it('exactly one participant announces, and the next takes over when it leaves', () => {
    const all = [a, b, c];
    const announcers = all.filter((me) => isAnnouncer(me, all.filter((x) => x !== me)));
    expect(announcers).toEqual([a]);
    const left = [b, c];
    expect(left.filter((me) => isAnnouncer(me, left.filter((x) => x !== me)))).toEqual([b]);
    expect(isAnnouncer(c, [])).toBe(true);
  });

  it('tells only the members who are not in the call', () => {
    expect(liveTargets([ANN, BEN, CAT, DAN], [ANN, CAT])).toEqual([BEN, DAN]);
    expect(liveTargets([ANN, BEN], new Set([ANN, BEN]))).toEqual([]);
  });
});

describe('live call hints on this device', () => {
  afterEach(() => { clearAllLiveCalls(); vi.useRealTimers(); });

  it('keeps the latest hint per conversation and forgets it when told the call is over', () => {
    setLiveCall({ convId: CONV.id, callId: CALL, n: 2, video: false, key: KEY });
    setLiveCall({ convId: CONV.id, callId: CALL, n: 3, video: false, key: KEY });
    expect(getLiveCall(CONV.id)).toMatchObject({ n: 3, callId: CALL });
    clearLiveCall(CONV.id, '44444444-4444-4444-8444-444444444444'); // another call: kept
    expect(getLiveCall(CONV.id)).not.toBeNull();
    clearLiveCall(CONV.id, CALL);
    expect(getLiveCall(CONV.id)).toBeNull();
  });

  it('expires when nobody refreshes it, and a refresh keeps it alive', () => {
    vi.useFakeTimers();
    setLiveCall({ convId: CONV.id, callId: CALL, n: 2, video: true, key: KEY });
    vi.advanceTimersByTime(LIVE_TTL_MS - 1000);
    setLiveCall({ convId: CONV.id, callId: CALL, n: 2, video: true, key: KEY });
    vi.advanceTimersByTime(LIVE_TTL_MS - 1000);
    expect(getLiveCall(CONV.id)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(getLiveCall(CONV.id)).toBeNull();
  });
});

describe('following devices', () => {
  it('switches to the remembered device when it appears', () => {
    expect(deviceAfterChange('default', 'headset', ['default', 'builtin', 'headset'])).toBe('headset');
    expect(deviceAfterChange('headset', 'headset', ['default', 'headset'])).toBeNull();
  });

  it('falls back to the default when the device in use is pulled out', () => {
    expect(deviceAfterChange('headset', 'headset', ['default', 'builtin'])).toBe('');
    expect(deviceAfterChange('usb-cam', undefined, ['builtin-cam'])).toBe('');
  });

  it('otherwise keeps what is in use', () => {
    expect(deviceAfterChange('builtin', undefined, ['default', 'builtin', 'headset'])).toBeNull();
    expect(deviceAfterChange(undefined, undefined, [])).toBeNull();
  });
});
