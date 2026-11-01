'use client';
// Which microphone / camera / speaker to use for calls (chosen in "Test camera and microphone",
// components/calls/CallCheck.tsx, or during a call, components/calls/CallDevices.tsx). Device ids are
// per-site identifiers the browser gives us; they're kept on this device only (localStorage), never sent
// anywhere. Used as `ideal` constraints, so a device that's gone simply falls back to the default.

export interface CallDevices {
  mic?: string;
  cam?: string;
  out?: string;
  /** Phones: the front or back camera (chosen by direction: device ids of phone cameras say little). */
  facing?: 'user' | 'environment';
  /** The Android app: call audio on the loudspeaker or the earpiece (a headset always wins). */
  route?: 'speaker' | 'earpiece';
}
const KEY = 'kw.calls.devices';
const ID_RE = /^[A-Za-z0-9+/=_-]{1,256}$/;

export function getCallDevices(): CallDevices {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const pick = (x: unknown) => (typeof x === 'string' && ID_RE.test(x) ? x : undefined);
    return {
      mic: pick(v.mic), cam: pick(v.cam), out: pick(v.out),
      facing: v.facing === 'user' || v.facing === 'environment' ? v.facing : undefined,
      route: v.route === 'speaker' || v.route === 'earpiece' ? v.route : undefined,
    };
  } catch { return {}; }
}

export function setCallDevices(patch: CallDevices): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...getCallDevices(), ...patch })); } catch { /* storage blocked: defaults */ }
}

/** Microphone constraints for calls: voice processing on, mono, the chosen device when there is one. */
export function micConstraints(): MediaTrackConstraints {
  const { mic } = getCallDevices();
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(mic ? { deviceId: { ideal: mic } } : {}) };
}

/**
 * The device list changed (a headset plugged in or pulled out, a webcam attached): which device a call
 * should switch to, '' for the system default, or null to keep the current one. The remembered choice
 * wins whenever it's there; a current device that disappeared falls back to the default.
 */
export function deviceAfterChange(current: string | undefined, preferred: string | undefined, available: string[]): string | null {
  if (preferred && available.includes(preferred)) return current === preferred ? null : preferred;
  if (current && !available.includes(current)) return '';
  return null;
}

/** Why the microphone or camera couldn't be used, from a getUserMedia error. */
export type MediaErr = 'denied' | 'missing' | 'busy' | 'other';
export function mediaErr(e: unknown): MediaErr {
  const n = (e as { name?: string } | null)?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'missing';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  return 'other';
}

/** Has the person already allowed the microphone (so no prompt will appear)? Unknown counts as no. */
export async function micAllowed(): Promise<boolean> {
  try {
    const r = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return r?.state === 'granted';
  } catch { return false; }
}
