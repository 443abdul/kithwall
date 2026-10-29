// Regression (owner report, Android test build 9): a passkey attempt that failed in the app, then the
// passphrase fallback, showed "Something went wrong". The sign-up page handed the SAME ALTCHA proof to the
// second attempt, and /register/options refuses a proof it already spent. Run: npx vitest run src/lib/auth/pow
import { describe, expect, it } from 'vitest';
import { proofSource } from './pow';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('sign-up proofs (proofSource)', () => {
  it('never hands out the same proof twice, and solves the next one ahead', async () => {
    let n = 0;
    const src = proofSource(async () => `proof-${++n}`);
    expect(n).toBe(1);                       // solving starts right away
    const a = await src.take();
    await tick();
    expect(n).toBe(2);                       // the next attempt's proof is already being solved
    const b = await src.take();
    const c = await src.take();
    expect(new Set([a, b, c]).size).toBe(3);
    src.stop();
  });

  it('retries once when the background solve failed', async () => {
    let n = 0;
    const src = proofSource(async () => { n++; if (n === 1) throw new Error('offline'); return `proof-${n}`; });
    expect(await src.take()).toBe('proof-2');
    src.stop();
  });

  it('stop() aborts the solve in progress and take() still works afterwards', async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const src = proofSource(async (signal) => { signals.push(signal); return `proof-${++n}`; });
    src.stop();
    expect(signals[0]!.aborted).toBe(true);
    expect(await src.take()).toBe('proof-2');
  });
});
