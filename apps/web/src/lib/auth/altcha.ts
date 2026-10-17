'use client';
// Browser side of the self-hosted ALTCHA proof-of-work. We use altcha-lib's solver directly
// instead of the <altcha-widget> web component: the widget's Svelte runtime creates a Trusted Types
// policy ("svelte-trusted-html") and Workers from blob: URLs, both of which our production CSP
// (require-trusted-types-for 'script', fixed policy allow-list) blocks. The solver only needs
// WebCrypto PBKDF2, runs async on the main thread without blocking it, and needs no CSP changes.
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';

export interface ChallengeResponse { challenge: Challenge; signupsEnabled: boolean }

export async function fetchChallenge(): Promise<ChallengeResponse> {
  const res = await fetch('/api/altcha/challenge', { cache: 'no-store' });
  if (!res.ok) throw new Error('Sign-up is temporarily unavailable.');
  return (await res.json()) as ChallengeResponse;
}

/** Solves a challenge; resolves to the payload string the auth hook verifies. */
export async function solve(challenge: Challenge, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort());
  const solution = await solveChallenge({ challenge, deriveKey, controller, timeout: 120_000 });
  if (!solution) throw new Error('The security check timed out. Reload the page and try again.');
  return JSON.stringify({ challenge, solution });
}
