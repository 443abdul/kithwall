'use client';
// Which microphone / camera / speaker to use for calls (chosen in "Test camera and microphone",
// components/calls/CallCheck.tsx). Device ids are per-site identifiers the browser gives us; they're kept
// on this device only (localStorage), never sent anywhere. Used as `ideal` constraints, so a device
// that's gone simply falls back to the default.

export interface CallDevices { mic?: string; cam?: string; out?: string }
const KEY = 'kw.calls.devices';
const ID_RE = /^[A-Za-z0-9+/=_-]{1,256}$/;

export function getCallDevices(): CallDevices {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    const pick = (x: unknown) => (typeof x === 'string' && ID_RE.test(x) ? x : undefined);
    return { mic: pick(v.mic), cam: pick(v.cam), out: pick(v.out) };
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
