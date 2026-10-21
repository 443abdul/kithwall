// Call safety code (docs/v2/04-calls.md §4): four emoji and six digits both people can read out to each
// other. It is derived from the call id, both identity keys and both DTLS certificate fingerprints taken
// from the negotiated SDP. The SDP travelled inside signed envelopes, so if the code matches on both
// screens, the encrypted media is flowing between exactly these two devices, with nothing in between.
// The identity keys are the ones behind the long-term safety number (/u/<handle>/verify).

export const SAFETY_EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦉',
  '🐝', '🦋', '🐢', '🐙', '🐬', '🐳', '🦀', '🐌', '🌵', '🌲', '🌻', '🌹', '🍄', '🌙', '⭐', '🔥',
  '🌈', '⛄', '🍎', '🍋', '🍉', '🍇', '🍓', '🥕', '🌽', '🍞', '🧀', '🍪', '🎂', '☕', '⚽', '🏀',
  '🎸', '🎈', '🎁', '🔑', '🔔', '📚', '✏️', '🚲', '🚗', '✈️', '🚀', '⛵', '🏠', '⏰', '💡', '🧭',
] as const;

/** First DTLS fingerprint in an SDP ("sha-256 AB:CD:…"), normalised; null when there is none. */
export function sdpFingerprint(sdp: string | null | undefined): string | null {
  if (!sdp) return null;
  const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/m.exec(sdp);
  return m ? `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}` : null;
}

export interface SafetyParty { userId: string; signPub: string; fingerprint: string }
export interface SafetyCode { emoji: string[]; digits: string }

const enc = new TextEncoder();

/** Same result on both ends (the two parties are sorted). */
export async function callSafetyCode(callId: string, a: SafetyParty, b: SafetyParty): Promise<SafetyCode> {
  const [x, y] = [a, b].sort((p, q) => (p.userId + p.fingerprint < q.userId + q.fingerprint ? -1 : 1));
  const text = ['kithwall/v1/call-safety', callId, x!.userId, x!.signPub, x!.fingerprint, y!.userId, y!.signPub, y!.fingerprint].join('\n');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  const emoji = [0, 1, 2, 3].map((i) => SAFETY_EMOJI[h[i]! & 63]!);
  const n = ((h[4]! << 16) | (h[5]! << 8) | h[6]!) % 1_000_000;
  return { emoji, digits: String(n).padStart(6, '0') };
}
