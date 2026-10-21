// End-to-end test of account recovery from a @handle (docs/v2/01-accounts.md §3) against a running dev
// server + local Supabase. Skipped unless E2E_BASE_URL is set, e.g. from apps/web:
//   NEXT_DIST_DIR=.next-rec npx next dev -p 3031        (in another terminal)
//   E2E_BASE_URL=http://localhost:3031 npx vitest run src/lib/auth/recovery.e2e.test.ts
// Reads keys from apps/web/.env.local. Creates and deletes its own users. With E2E_KEEP_FILE=<path> it
// also leaves one extra email-less account behind and writes its handle + recovery phrase there (for a
// browser walk-through of /recover).
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { b64u, createKeyBundle, deriveFromPassword, generateEphemeral, signChallenge, unlockWithRecoveryPhrase, type KeyBundle } from '@kithwall/crypto';

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

async function call<T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function altcha(): Promise<string> {
  const { data } = await call<{ challenge: Challenge }>('/api/altcha/challenge');
  const solution = await solveChallenge({ challenge: data.challenge, deriveKey, controller: new AbortController(), timeout: 120_000 });
  return JSON.stringify({ challenge: data.challenge, solution });
}

/** A passphrase (email-less) account; returns its handle, id and recovery phrase. */
async function passphraseAccount(prefix: string): Promise<{ handle: string; userId: string; phrase: string }> {
  const handle = `${prefix}${randomBytes(4).toString('hex')}`;
  const start = await call<{ challengeId: string; userId: string; email: string }>(
    '/api/auth/passkey/register/options', { handle, altcha: await altcha(), mode: 'passphrase' });
  expect(start.status).toBe(200);
  const d = await deriveFromPassword(start.data.email, 'correct horse battery staple orbit');
  const { bundle, recoveryPhrase } = createKeyBundle(start.data.userId, d.passwordKEK);
  const done = await call('/api/auth/passkey/register/verify', { challengeId: start.data.challengeId, bundle, authKey: d.authKey });
  expect(done.status).toBe(200);
  return { handle, userId: start.data.userId, phrase: recoveryPhrase };
}

interface AccountRes { userId: string; challengeId: string; nonce: string; bundle: KeyBundle; trusted: unknown }

run('Recovery from a @handle (e2e)', () => {
  const created: string[] = [];
  afterAll(async () => {
    const db = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);
    for (const id of created) await db.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it('recovery key: nonce + recovery wrap → signed proof → session; single use; no passphrase wrap', async () => {
    const acct = await passphraseAccount('rec');
    created.push(acct.userId);

    expect((await call('/api/recovery/account', { altcha: await altcha(), handle: `${acct.handle}zz` })).data).toMatchObject({ code: 'no_account' });
    expect((await call('/api/recovery/account', { altcha: await altcha(), handle: 'x' })).status).toBe(400);

    const a = await call<AccountRes>('/api/recovery/account', { altcha: await altcha(), handle: acct.handle.toUpperCase() });
    expect(a.status).toBe(200);
    expect(a.data.userId).toBe(acct.userId);
    expect(a.data.bundle).not.toHaveProperty('amkByPassword');
    expect(a.data.trusted).toBeNull();

    const u = unlockWithRecoveryPhrase(acct.userId, a.data.bundle, acct.phrase);
    // A wrong signature (signed over another nonce) is refused…
    const wrong = await call('/api/recovery/finish', { userId: acct.userId, challengeId: a.data.challengeId, signature: signChallenge(u.identity.signPriv, 'not-the-nonce') });
    expect(wrong.status).toBe(403);
    // …and so is a well-formed signature by a key that isn't the account's.
    const other = createKeyBundle(acct.userId, null);
    const b = await call<AccountRes>('/api/recovery/account', { altcha: await altcha(), handle: acct.handle });
    const forged = await call('/api/recovery/finish', { userId: acct.userId, challengeId: b.data.challengeId, signature: signChallenge(other.unlocked.identity.signPriv, b.data.nonce) });
    expect(forged.status).toBe(403);

    const c = await call<AccountRes>('/api/recovery/account', { altcha: await altcha(), handle: acct.handle });
    const proof = { userId: acct.userId, challengeId: c.data.challengeId, signature: signChallenge(u.identity.signPriv, c.data.nonce) };
    const fin = await call<{ tokenHash: string }>('/api/recovery/finish', proof);
    expect(fin.status).toBe(200);
    const client = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
    const { data, error } = await client.auth.verifyOtp({ token_hash: fin.data.tokenHash, type: 'magiclink' });
    expect(error).toBeNull();
    expect(data.user?.id).toBe(acct.userId);
    // The challenge is spent.
    expect((await call('/api/recovery/finish', proof)).status).toBe(403);
  }, 180_000);

  it('trusted friends: refused for an account without friends; unknown request ids are 404', async () => {
    const acct = await passphraseAccount('rcf');
    created.push(acct.userId);
    const e = generateEphemeral();
    const r = await call('/api/recovery/friends/start', { altcha: await altcha(), handle: acct.handle, ephPub: b64u.encode(e.pub) });
    expect(r.status).toBe(409);
    expect(r.data).toMatchObject({ code: 'no_trustees' });
    expect((await call('/api/recovery/friends/start', { handle: acct.handle, ephPub: 'short' })).status).toBe(400);
    // Security review W4: no proof-of-work, no request (and no lookup); a spent one can't be replayed.
    expect((await call('/api/recovery/friends/start', { handle: acct.handle, ephPub: b64u.encode(e.pub) })).status).toBe(400);
    expect((await call('/api/recovery/account', { handle: acct.handle })).status).toBe(400);
    const pow = await altcha();
    expect((await call('/api/recovery/account', { altcha: pow, handle: acct.handle })).status).toBe(200);
    expect((await call('/api/recovery/account', { altcha: pow, handle: acct.handle })).status).toBe(400);
    expect((await call('/api/recovery/friends/status', { requestId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  }, 180_000);

  it('R-W4: one IPv6 /64 is one requester, and strangers at the cap cannot keep the owner out', async () => {
    const owner = await passphraseAccount('rw4');
    const friend = await passphraseAccount('rw4f');
    created.push(owner.userId, friend.userId);
    const db = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);
    const share = await db.from('recovery_shares').insert({ owner_id: owner.userId, trustee_id: friend.userId,
      setup_id: randomUUID(), threshold: 2, sealed: { s: 'x' } });
    expect(share.error).toBeNull();
    const start = async (xff: string) => {
      const res = await fetch(`${BASE}/api/recovery/friends/start`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
        body: JSON.stringify({ altcha: await altcha(), handle: owner.handle, ephPub: b64u.encode(generateEphemeral().pub) }),
      });
      return res.status;
    };
    // The re-review's attacker rotated through addresses of ONE /64: now they all share one tag (2 a day).
    const net = `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;
    expect(await start(`${net}::1`)).toBe(200);
    expect(await start(`${net}:aaaa::2`)).toBe(200);
    expect(await start(`${net}:bbbb:cccc:dddd:3`)).toBe(429);
    // Ten distinct IPv4 requesters fill the account to its cap of 10 open requests...
    const v4 = () => `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (let i = 0; i < 10; i++) expect(await start(v4())).toBe(200);
    const open = await db.from('recovery_requests').select('id', { count: 'exact', head: true }).eq('owner_id', owner.userId).eq('status', 'pending');
    expect(open.count).toBe(10);
    // ...and the owner, trying from their own new device, still gets in (the oldest open request makes room).
    expect(await start(v4())).toBe(200);
    const after = await db.from('recovery_requests').select('id', { count: 'exact', head: true }).eq('owner_id', owner.userId).eq('status', 'pending');
    expect(after.count).toBe(10);
  }, 300_000);

  if (process.env.E2E_KEEP_FILE) {
    it('leaves an account for the browser walk-through', async () => {
      const acct = await passphraseAccount('rcb');
      writeFileSync(process.env.E2E_KEEP_FILE!, JSON.stringify(acct, null, 2));
    }, 180_000);
  }
});
