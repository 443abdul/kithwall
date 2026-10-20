// Local PIN attempt limiter (docs/v2/03-safety.md §2). Pure functions; the state lives in the device
// store (lib/keys/device.ts pinStore.attempts). It slows down guessing on THIS device; it is not a
// cryptographic guarantee (someone with developer tools on an unlocked browser can reset it — the
// Argon2id cost per guess and the optional wipe still apply).

export interface AttemptState { failures: number; lockedUntil: number }

export const FRESH: AttemptState = Object.freeze({ failures: 0, lockedUntil: 0 }) as AttemptState;

/** Wait after the n-th consecutive failure: three free tries, then 30 s, 1 min, 5 min, 15 min, 1 h. */
export function delayAfter(failures: number): number {
  if (failures <= 3) return 0;
  const steps = [30_000, 60_000, 5 * 60_000, 15 * 60_000];
  return steps[failures - 4] ?? 60 * 60_000;
}

/** Milliseconds until the next attempt is allowed (0 = now). */
export function attemptWait(s: AttemptState, now: number): number {
  return Math.max(0, s.lockedUntil - now);
}

/** Record a wrong PIN. `wipe` is true when the configured limit is reached. */
export function noteFailure(s: AttemptState, now: number, wipeAfter: number | null): { state: AttemptState; wipe: boolean; wait: number } {
  const failures = s.failures + 1;
  const wait = delayAfter(failures);
  return {
    state: { failures, lockedUntil: now + wait },
    wipe: wipeAfter !== null && wipeAfter > 0 && failures >= wipeAfter,
    wait,
  };
}

/** A correct PIN (real or duress — they must look the same) resets the counter. */
export function noteSuccess(): AttemptState { return { ...FRESH }; }

export function isAttemptState(v: unknown): v is AttemptState {
  const s = v as AttemptState | null;
  return !!s && Number.isSafeInteger(s.failures) && s.failures >= 0 && Number.isFinite(s.lockedUntil);
}

/** Allowed values for "wipe this device after N wrong PINs". */
export const WIPE_AFTER_CHOICES = [null, 5, 10, 15] as const;
