// The call state machine (docs/v2/04-calls.md §5). Pure: the engine (engine.ts) feeds it events and
// renders whatever phase comes out, so every transition is unit-tested.
//
//   idle ──place──▶ outgoing ──peer-connected──▶ active ──hangup / last peer left──▶ ended
//   idle ──ring───▶ incoming ──accept──▶ connecting ──peer-connected──▶ active
//                   incoming ──decline / timeout / cancel / answered-elsewhere──▶ ended
//   outgoing ──all declined / busy / timeout──▶ ended
//   ended ──reset──▶ idle

export type Phase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export type EndReason =
  | 'hangup'            // I hung up
  | 'remote'            // the other side(s) hung up
  | 'declined'          // everyone I called declined
  | 'busy'              // the person I called is in another call
  | 'no-answer'         // nobody picked up in time (caller)
  | 'missed'            // I didn't pick up in time, or the caller gave up (callee)
  | 'rejected'          // I declined
  | 'elsewhere'         // I answered on another device
  | 'failed'            // couldn't connect
  | 'no-media'          // microphone / camera unavailable or refused
  | 'relay';            // "Always relay" is on but the relay couldn't be reached (fail fast, never go direct)

export interface MachineState {
  phase: Phase;
  /** People (user ids) invited to the call, excluding me. */
  invited: string[];
  /** Invited people who declined (or are busy). */
  declined: string[];
  /** Endpoints currently connected. */
  connected: number;
  /** Did anyone ever connect? */
  everConnected: boolean;
  reason: EndReason | null;
}

export type MachineEvent =
  | { t: 'place'; invited: string[] }
  | { t: 'ring'; invited: string[] }
  | { t: 'accept' }
  | { t: 'decline' }
  | { t: 'peer-connected'; count: number }
  | { t: 'peer-left'; count: number }
  | { t: 'remote-declined'; userId: string; busy?: boolean }
  | { t: 'cancelled' }
  | { t: 'answered-elsewhere' }
  | { t: 'timeout' }
  | { t: 'hangup' }
  | { t: 'failed'; reason?: 'failed' | 'no-media' | 'relay' }
  | { t: 'reset' };

export const IDLE: MachineState = Object.freeze({ phase: 'idle', invited: [], declined: [], connected: 0, everConnected: false, reason: null }) as MachineState;

const end = (s: MachineState, reason: EndReason): MachineState => ({ ...s, phase: 'ended', connected: 0, reason });

export function step(s: MachineState, e: MachineEvent): MachineState {
  switch (e.t) {
    case 'reset': return IDLE;
    case 'place':
      return s.phase === 'idle' || s.phase === 'ended' ? { ...IDLE, phase: 'outgoing', invited: [...e.invited] } : s;
    case 'ring':
      return s.phase === 'idle' || s.phase === 'ended' ? { ...IDLE, phase: 'incoming', invited: [...e.invited] } : s;
    case 'accept':
      return s.phase === 'incoming' ? { ...s, phase: 'connecting' } : s;
    case 'decline':
      return s.phase === 'incoming' ? end(s, 'rejected') : s;
    case 'answered-elsewhere':
      return s.phase === 'incoming' ? end(s, 'elsewhere') : s;
    case 'cancelled':
      return s.phase === 'incoming' || (s.phase === 'connecting' && s.connected === 0) ? end(s, 'missed') : s;
    case 'peer-connected':
      if (s.phase !== 'outgoing' && s.phase !== 'connecting' && s.phase !== 'active') return s;
      return { ...s, phase: 'active', connected: Math.max(e.count, 1), everConnected: true };
    case 'peer-left':
      if (s.phase === 'active' || s.phase === 'connecting') {
        if (e.count > 0) return { ...s, connected: e.count };
        return s.everConnected || s.phase === 'connecting' ? end(s, 'remote') : s;
      }
      if (s.phase === 'outgoing') return { ...s, connected: e.count };
      return s;
    case 'remote-declined': {
      if (s.phase !== 'outgoing') return s;
      const declined = s.declined.includes(e.userId) ? s.declined : [...s.declined, e.userId];
      const next = { ...s, declined };
      if (s.invited.every((u) => declined.includes(u))) return end(next, e.busy && s.invited.length === 1 ? 'busy' : 'declined');
      return next;
    }
    case 'timeout':
      if (s.phase === 'outgoing') return end(s, 'no-answer');
      if (s.phase === 'incoming') return end(s, 'missed');
      if (s.phase === 'connecting') return end(s, 'failed');
      return s;
    case 'hangup':
      if (s.phase === 'incoming') return end(s, 'rejected');
      return s.phase === 'idle' || s.phase === 'ended' ? s : end(s, 'hangup');
    case 'failed':
      return s.phase === 'idle' || s.phase === 'ended' ? s : end(s, e.reason ?? 'failed');
  }
}

/** Is the call using the microphone/camera (anything between placing/accepting and ending)? */
export const isLive = (p: Phase) => p === 'outgoing' || p === 'connecting' || p === 'active';
