// Security re-review R-W3, end to end: passphrase sign-in through /api/auth/passkey/passphrase/signin
// (a constant-cost check in the database and a per-handle limit) instead of GoTrue's password grant, whose
// timing told passphrase accounts apart from passkey-only accounts and unknown handles.
// Skipped unless E2E_BASE_URL is set, e.g. from apps/web:
//   NEXT_DIST_DIR=.next-acct npx next dev -p 3011        (in another terminal)
//   E2E_BASE_URL=http://localhost:3011 npx vitest run src/lib/auth/passphrase-signin.e2e.test.ts
// Reads keys from apps/web/.env.local. Creates and deletes its own users.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { createKeyBundle, deriveFromPassword } from '@kithwall/crypto';

const BASE = process.env.E2E_BASE_URL ?? '';
const run = BASE ? describe : describe.skip;

function env(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}
const E = env();
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;
const ip = () => `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call<T = Record<string, unknown>>(path: string, body: unknown, xff = ip()): Promise<{ status: number; data: T; ms: number }> {
  const t = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data, ms: performance.now() - t };
}

async function altcha(): Promise<string> {
  const res = await fetch(`${BASE}/api/altcha/challenge`);
  const { challenge } = (await res.json()) as { challenge: Challenge };
  const solution = await solveChallenge({ challenge, deriveKey, controller: new AbortController(), timeout: 120_000 });
  return JSON.stringify({ challenge, solution });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

run('Passphrase sign-in through the server (R-W3)', () => {
  const created: string[] = [];
  afterAll(async () => {
    const db = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);
    for (const id of created) await db.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it('signs in with the right key only, answers wrong keys and unknown handles alike, and limits per handle', async () => {
    const handle = `pss${randomBytes(4).toString('hex')}`;
    const passphrase = 'correct horse battery staple orbit';
    const start = await call<{ challengeId: string; userId: string; email: string }>(
      '/api/auth/passkey/register/options', { handle, altcha: await altcha(), mode: 'passphrase' });
    expect(start.status).toBe(200);
    created.push(start.data.userId);
    const d = await deriveFromPassword(start.data.email, passphrase);
    const { bundle } = createKeyBundle(start.data.userId, d.passwordKEK);
    expect((await call('/api/auth/passkey/register/verify', { challengeId: start.data.challengeId, bundle, authKey: d.authKey })).status).toBe(200);

    // The lookup gives the synthetic address; the right authKey gets a one-time session token.
    const look = await call<{ email: string }>('/api/auth/passkey/passphrase/lookup', { handle });
    expect(look.data.email).toBe(start.data.email);
    const ok = await call<{ tokenHash: string }>('/api/auth/passkey/passphrase/signin', { email: look.data.email, authKey: d.authKey });
    expect(ok.status).toBe(200);
    const client = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
    const v = await client.auth.verifyOtp({ token_hash: ok.data.tokenHash, type: 'magiclink' });
    expect(v.data.user?.id).toBe(start.data.userId);

    // Wrong passphrase vs unknown handle (a decoy address): same answer, about the same time.
    const decoy = await call<{ email: string }>('/api/auth/passkey/passphrase/lookup', { handle: `nobody${randomBytes(4).toString('hex')}` });
    const wrongKey = (await deriveFromPassword(look.data.email, 'not the passphrase at all')).authKey;
    const real: number[] = [];
    const fake: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = await call('/api/auth/passkey/passphrase/signin', { email: look.data.email, authKey: wrongKey });
      const b = await call('/api/auth/passkey/passphrase/signin', { email: decoy.data.email, authKey: wrongKey });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.data).toEqual(b.data);
      real.push(a.ms); fake.push(b.ms);
    }
    const ratio = median(real) / median(fake);
    console.log(`R-W3 timing: wrong passphrase ${median(real).toFixed(0)} ms, unknown handle ${median(fake).toFixed(0)} ms (ratio ${ratio.toFixed(2)})`);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);

    // Per handle from one client: 10 attempts per 15 minutes, then 429 (even with the right key).
    const xff = ip();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call('/api/auth/passkey/passphrase/signin', { email: look.data.email, authKey: wrongKey }, xff)).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await call('/api/auth/passkey/passphrase/signin', { email: look.data.email, authKey: d.authKey }, xff)).status).toBe(429);
    // Malformed input is refused without a lookup.
    expect((await call('/api/auth/passkey/passphrase/signin', { email: 'someone@example.com', authKey: d.authKey })).status).toBe(400);
  }, 300_000);
});
