// Single-use ALTCHA proofs for sign-up (JoinFlow). The server spends every proof it accepts at
// /api/auth/passkey/register/options (altcha_spent), even when the sign-up then fails (passkey prompt
// closed, Credential Manager refused, handle taken…). So each attempt needs a FRESH proof: handing the
// same payload to a second attempt (for example the passphrase fallback after a failed passkey) got
// "This sign-up form has already been used" — shown as "Something went wrong".
// Pure (no React, no DOM) so it is unit-tested in pow.test.ts.

export interface ProofSource {
  /** The proof for the next attempt (never one handed out before); retries once if the solve failed. */
  take(): Promise<string>;
  /** Stop any solve in progress. */
  stop(): void;
}

/**
 * `solveOne(signal)` fetches a challenge and solves it. One proof is solved ahead in the background so
 * an attempt usually doesn't wait; taking it immediately starts solving the next one.
 */
export function proofSource(solveOne: (signal: AbortSignal) => Promise<string>): ProofSource {
  let next: { p: Promise<string>; ctl: AbortController } | null = null;
  let stopped = false;
  const begin = () => {
    const ctl = new AbortController();
    const p = solveOne(ctl.signal);
    p.catch(() => undefined); // surfaced when taken
    next = { p, ctl };
    return next;
  };
  begin();
  return {
    async take() {
      stopped = false;
      const job = next ?? begin();
      next = null;
      let payload: string;
      try { payload = await job.p; } catch {
        const retry = begin();
        next = null;
        payload = await retry.p;
      }
      if (!stopped) begin();   // solve the proof for a possible next attempt in the background
      return payload;
    },
    stop() {
      stopped = true;
      next?.ctl.abort();
      next = null;
    },
  };
}
