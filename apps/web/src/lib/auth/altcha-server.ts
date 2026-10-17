import 'server-only';
// Self-hosted ALTCHA proof-of-work (spec §7): the browser spends a few seconds of CPU before it may
// sign up. Challenges are HMAC-signed, expire after 10 minutes and are single-use (the hook records
// spent signatures in public.altcha_spent).
import { createHmac } from 'node:crypto';
import { createChallenge, randomInt, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

export const ALTCHA_ALGORITHM = 'PBKDF2/SHA-256';
const COST = 500;                       // PBKDF2 iterations per attempt
const COUNTER_MIN = 2_000, COUNTER_MAX = 5_000; // ≈ 1–4 s on a laptop
const TTL_MS = 10 * 60_000;

function secrets(): { sig: string; key: string } {
  const base = process.env.ALTCHA_HMAC_KEY ?? '';
  if (base.length < 32) throw new Error('ALTCHA_HMAC_KEY must be at least 32 characters');
  // Two independent secrets derived from the one configured key.
  const sig = createHmac('sha256', base).update('kithwall/altcha/challenge').digest('hex');
  const key = createHmac('sha256', base).update('kithwall/altcha/key').digest('hex');
  return { sig, key };
}

export async function newChallenge(): Promise<Challenge> {
  const s = secrets();
  return createChallenge({
    algorithm: ALTCHA_ALGORITHM, cost: COST, counter: randomInt(COUNTER_MAX, COUNTER_MIN), deriveKey,
    expiresAt: new Date(Date.now() + TTL_MS), hmacSignatureSecret: s.sig, hmacKeySignatureSecret: s.key,
  });
}

export interface AltchaPayload { challenge: Challenge; solution: Solution }

/** Parses the payload the sign-up form put in user metadata (a JSON string, ≤ 4 KB). */
export function parsePayload(raw: unknown): AltchaPayload | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const p = JSON.parse(raw) as AltchaPayload;
    if (!p || typeof p !== 'object' || !p.challenge?.parameters || !p.solution) return null;
    if (p.challenge.parameters.algorithm !== ALTCHA_ALGORITHM || !p.challenge.parameters.expiresAt) return null;
    if (typeof p.challenge.signature !== 'string' || p.challenge.signature.length < 16 || p.challenge.signature.length > 256) return null;
    return p;
  } catch { return null; }
}

/** Signature valid, not expired, and the work was actually done. */
export async function verifyPayload(p: AltchaPayload): Promise<boolean> {
  const s = secrets();
  try {
    const r = await verifySolution({ challenge: p.challenge, solution: p.solution, deriveKey, hmacSignatureSecret: s.sig, hmacKeySignatureSecret: s.key });
    return r.verified && !r.expired;
  } catch { return false; }
}
