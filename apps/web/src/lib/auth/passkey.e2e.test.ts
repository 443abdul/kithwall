// End-to-end test of the Kithwall 2 account routes against a running dev server + local Supabase,
// with a software WebAuthn authenticator (P-256, "none" attestation, simulated PRF).
// Skipped unless E2E_BASE_URL is set, e.g. from apps/web:
//   NEXT_DIST_DIR=.next-acct npx next dev -p 3011        (in another terminal)
//   E2E_BASE_URL=http://localhost:3011 npx vitest run src/lib/auth/passkey.e2e.test.ts
// Reads NEXT_PUBLIC_SUPABASE_URL / keys from apps/web/.env.local. Creates and deletes its own users.
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import {
  PRF_APP_SALT, b64u, createKeyBundle, deriveFromPassword, generateIdentity, newPrfSalt, signChallenge, unlockWithPassword, unlockWithPrf, wrapAmkWithPrf,
  type KeyBundle,
} from '@kithwall/crypto';

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
const anonClient = () => createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
const adminClient = () => createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);

// ------------------------------------------------------------------------------------------------
// Software authenticator
// ------------------------------------------------------------------------------------------------
const enc = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

class SoftAuthenticator {
  readonly credId = randomBytes(32);
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly prfSecret = randomBytes(32);
  counter = 0;
  userHandle = '';
  constructor(private origin: string, private rpId: string) {}
  get id() { return enc(this.credId); }

  /** What the PRF extension would return for our fixed app salt. */
  prf(): Uint8Array {
    return new Uint8Array(createHmac('sha256', this.prfSecret).update(Buffer.from(PRF_APP_SALT)).digest());
  }

  private cose(): Uint8Array {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const m = new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]);
    return isoCBOR.encode(m);
  }

  private authData(attested: boolean): Buffer {
    const flags = 0x01 | 0x04 | 0x08 | 0x10 | (attested ? 0x40 : 0);   // UP, UV, BE, BS, AT
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const parts = [sha(this.rpId), Buffer.of(flags), cnt];
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
      parts.push(Buffer.alloc(16), len, this.credId, Buffer.from(this.cose()));
    }
    return Buffer.concat(parts);
  }

  register(options: { challenge: string; user: { id: string }; rp: { id?: string } }) {
    expect(options.rp.id).toBe(this.rpId);
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(this.authData(true))],
    ]) as never);
    return {
      id: this.id, rawId: this.id, type: 'public-key' as const, authenticatorAttachment: 'platform' as const,
      response: { clientDataJSON: enc(clientDataJSON), attestationObject: enc(attestationObject), transports: ['internal', 'hybrid'] },
      clientExtensionResults: { prf: { enabled: true } },
    };
  }

  assert(options: { challenge: string }, counter?: number) {
    if (counter !== undefined) this.counter = counter;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const authenticatorData = this.authData(false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), this.key.privateKey);
    return {
      id: this.id, rawId: this.id, type: 'public-key' as const, authenticatorAttachment: 'platform' as const,
      response: {
        clientDataJSON: enc(clientDataJSON), authenticatorData: enc(authenticatorData), signature: enc(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

// ------------------------------------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------------------------------------
async function call<T = Record<string, unknown>>(path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

async function altcha(): Promise<string> {
  const { data } = await call<{ challenge: Challenge }>('/api/altcha/challenge');
  const solution = await solveChallenge({ challenge: data.challenge, deriveKey, controller: new AbortController(), timeout: 120_000 });
  return JSON.stringify({ challenge: data.challenge, solution });
}

const created: string[] = [];
const rpId = BASE ? new URL(BASE).hostname : 'localhost';
const origin = BASE ? new URL(BASE).origin : '';

async function signedInClient(tokenHash: string): Promise<{ client: SupabaseClient; userId: string; token: string }> {
  const client = anonClient();
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  expect(error).toBeNull();
  return { client, userId: data.user!.id, token: data.session!.access_token };
}

run('Kithwall 2 accounts (e2e)', () => {
  afterAll(async () => {
    const db = adminClient();
    for (const id of created) await db.auth.admin.deleteUser(id).catch(() => undefined);
  });

  const handle = `e2e${randomBytes(4).toString('hex')}`;
  const auth = new SoftAuthenticator(origin, rpId);
  let userId = '';
  let signPub = '';
  let amkHex = '';

  it('creates a passkey-first account (no email, no password)', async () => {
    expect((await call(`/api/auth/passkey/handle?h=${handle}`)).data).toEqual({ problem: null });
    const start = await call<{ challengeId: string; userId: string; options: Parameters<SoftAuthenticator['register']>[0] }>(
      '/api/auth/passkey/register/options', { handle, altcha: await altcha(), mode: 'passkey' });
    expect(start.status).toBe(200);
    userId = start.data.userId;
    created.push(userId);
    const response = auth.register(start.data.options);
    const { bundle, unlocked } = createKeyBundle(userId, null);
    signPub = bundle.signPub;
    amkHex = Buffer.from(unlocked.amk).toString('hex');
    const prfSalt = newPrfSalt();
    const amkWrap = wrapAmkWithPrf(userId, auth.id, unlocked.amk, auth.prf(), prfSalt);

    // A response that leaks the PRF output is refused.
    const leaky = { ...response, clientExtensionResults: { prf: { results: { first: 'x' } } } };
    const bad = await call('/api/auth/passkey/register/verify', { challengeId: start.data.challengeId, bundle, passkey: { response: leaky, prfSalt, amkWrap } });
    expect(bad.status).toBe(400);
    // …and the challenge is single-use, so start over.
    const again = await call<typeof start.data>('/api/auth/passkey/register/options', { handle, altcha: await altcha(), mode: 'passkey' });
    userId = again.data.userId; created.push(userId);
    const { bundle: b2, unlocked: u2 } = createKeyBundle(userId, null);
    signPub = b2.signPub; amkHex = Buffer.from(u2.amk).toString('hex');
    const salt2 = newPrfSalt();
    const done = await call<{ userId: string; email: string; tokenHash: string }>('/api/auth/passkey/register/verify', {
      challengeId: again.data.challengeId, bundle: b2,
      passkey: { response: auth.register(again.data.options), label: 'Test phone', prfSalt: salt2, amkWrap: wrapAmkWithPrf(userId, auth.id, u2.amk, auth.prf(), salt2) },
    });
    expect(done.status).toBe(200);
    expect(done.data.email).toMatch(/@id\.kithwall\.invalid$/);
    const { client } = await signedInClient(done.data.tokenHash);
    const prof = await client.from('profiles').select('username, sign_pub').eq('id', userId).single();
    expect(prof.data).toEqual({ username: handle, sign_pub: signPub });
    const pk = await client.from('passkeys').select('label, credential_id').single();
    expect(pk.data).toEqual({ label: 'Test phone', credential_id: auth.id });
    expect((await call(`/api/auth/passkey/handle?h=${handle}`)).data).toEqual({ problem: 'taken' });
    // Replaying the one-time token fails.
    const replay = await anonClient().auth.verifyOtp({ token_hash: done.data.tokenHash, type: 'magiclink' });
    expect(replay.error).not.toBeNull();
  }, 120_000);

  it('refuses a second account with the same handle', async () => {
    const start = await call('/api/auth/passkey/register/options', { handle, altcha: await altcha(), mode: 'passkey' });
    expect(start.status).toBe(409);
    expect(start.data.code).toBe('handle_taken');
  }, 60_000);

  it('signs in with the discoverable passkey and unlocks the keys', async () => {
    const start = await call<{ challengeId: string; options: { challenge: string; allowCredentials?: unknown[] } }>('/api/auth/passkey/login/options', {});
    expect(start.data.options.allowCredentials ?? []).toEqual([]);
    const assertion = auth.assert(start.data.options, 0);
    const done = await call<{ userId: string; tokenHash: string; credentialId: string; wrap: { prfSalt: string; amkWrap: string } }>(
      '/api/auth/passkey/login/verify', { challengeId: start.data.challengeId, response: assertion });
    expect(done.status).toBe(200);
    expect(done.data.userId).toBe(userId);
    const { client } = await signedInClient(done.data.tokenHash);
    const bundle = (await client.from('key_bundles').select('bundle').single()).data!.bundle as KeyBundle;
    expect(bundle.amkByPassword).toBeUndefined();
    const u = unlockWithPrf(userId, bundle, done.data.credentialId, done.data.wrap.amkWrap, auth.prf(), done.data.wrap.prfSalt);
    expect(Buffer.from(u.amk).toString('hex')).toBe(amkHex);
    expect(b64u.encode(u.identity.signPub)).toBe(signPub);

    // The same assertion cannot be replayed (challenge consumed).
    const replay = await call('/api/auth/passkey/login/verify', { challengeId: start.data.challengeId, response: assertion });
    expect(replay.status).toBe(400);
    // A wrong PRF (another authenticator) cannot open the wrap.
    expect(() => unlockWithPrf(userId, bundle, done.data.credentialId, done.data.wrap.amkWrap, new Uint8Array(32), done.data.wrap.prfSalt)).toThrow();
  }, 60_000);

  it('rejects unknown passkeys and bad signatures', async () => {
    const stranger = new SoftAuthenticator(origin, rpId);
    const s1 = await call<{ challengeId: string; options: { challenge: string } }>('/api/auth/passkey/login/options', {});
    const r1 = await call('/api/auth/passkey/login/verify', { challengeId: s1.data.challengeId, response: stranger.assert(s1.data.options) });
    expect(r1.status).toBe(404);
    expect(r1.data.code).toBe('no_account_for_passkey');
    const s2 = await call<{ challengeId: string; options: { challenge: string } }>('/api/auth/passkey/login/options', {});
    const forged = auth.assert({ challenge: 'AAAA' });   // signed over the wrong challenge
    const r2 = await call('/api/auth/passkey/login/verify', { challengeId: s2.data.challengeId, response: forged });
    expect(r2.status).toBe(401);
  }, 60_000);

  it('adds a second passkey, refuses removing the last one, notice email verify flow', async () => {
    const s = await call<{ challengeId: string; options: { challenge: string } }>('/api/auth/passkey/login/options', {});
    const done = await call<{ tokenHash: string; wrap: { prfSalt: string; amkWrap: string }; credentialId: string }>(
      '/api/auth/passkey/login/verify', { challengeId: s.data.challengeId, response: auth.assert(s.data.options) });
    const { client, token } = await signedInClient(done.data.tokenHash);
    const bundle = (await client.from('key_bundles').select('bundle').single()).data!.bundle as KeyBundle;
    const u = unlockWithPrf(userId, bundle, done.data.credentialId, done.data.wrap.amkWrap, auth.prf(), done.data.wrap.prfSalt);

    expect((await call('/api/auth/passkey/add/options', {})).status).toBe(401);
    const second = new SoftAuthenticator(origin, rpId);
    const start = await call<{ challengeId: string; options: Parameters<SoftAuthenticator['register']>[0] & { excludeCredentials: { id: string }[] } }>(
      '/api/auth/passkey/add/options', {}, token);
    expect(start.status).toBe(200);
    expect(start.data.options.excludeCredentials.map((c) => c.id)).toEqual([auth.id]);
    expect(start.data.options.user.id).toBe(auth.userHandle);   // same WebAuthn user handle
    const prfSalt = newPrfSalt();
    // Security review W2: a stolen access token alone can't add a passkey (no proof of the identity key,
    // or a proof by another key, is refused, and the attempt burns the challenge).
    const thief = new SoftAuthenticator(origin, rpId);
    for (const keyProof of [undefined, signChallenge(generateIdentity().signPriv, `kithwall/v1/add-passkey/${start.data.options.challenge}`)]) {
      const st = keyProof ? await call<typeof start.data>('/api/auth/passkey/add/options', {}, token) : start;
      const stolen = await call('/api/auth/passkey/add/verify', {
        challengeId: st.data.challengeId, response: thief.register(st.data.options), label: 'Thief', prfSalt,
        amkWrap: wrapAmkWithPrf(userId, thief.id, randomBytes(32), thief.prf(), prfSalt), keyProof,
      }, token);
      expect(stolen.status).toBe(403);
    }
    expect((await client.from('passkeys').select('id')).data).toHaveLength(1);
    const start2 = await call<typeof start.data>('/api/auth/passkey/add/options', {}, token);
    const add = await call<{ id: string }>('/api/auth/passkey/add/verify', {
      challengeId: start2.data.challengeId, response: second.register(start2.data.options), label: 'Laptop',
      prfSalt, amkWrap: wrapAmkWithPrf(userId, second.id, u.amk, second.prf(), prfSalt),
      keyProof: signChallenge(u.identity.signPriv, `kithwall/v1/add-passkey/${start2.data.options.challenge}`),
    }, token);
    expect(add.status).toBe(200);
    // Every device hears about it (in-app notification → push), content-free.
    expect((await client.from('notifications').select('type').eq('type', 'security_notice')).data).toHaveLength(1);
    expect((await client.from('passkeys').select('id')).data).toHaveLength(2);

    // Sign in with the second passkey opens the same keys.
    const s2 = await call<{ challengeId: string; options: { challenge: string } }>('/api/auth/passkey/login/options', {});
    const d2 = await call<{ wrap: { prfSalt: string; amkWrap: string }; credentialId: string }>(
      '/api/auth/passkey/login/verify', { challengeId: s2.data.challengeId, response: second.assert(s2.data.options) });
    expect(d2.data.credentialId).toBe(second.id);
    expect(Buffer.from(unlockWithPrf(userId, bundle, second.id, d2.data.wrap.amkWrap, second.prf(), d2.data.wrap.prfSalt).amk).toString('hex')).toBe(amkHex);

    // Remove: one of two is fine; the last one is refused (no passphrase, recovery not confirmed).
    const ok = await client.rpc('remove_passkey', { p_id: add.data.id });
    expect(ok.error).toBeNull();
    const last = (await client.from('passkeys').select('id').single()).data!.id as string;
    const refused = await client.rpc('remove_passkey', { p_id: last });
    expect(refused.error?.message).toMatch(/last unlock method/);

    // Notice email: stored only once verified via the link.
    const set = await call<{ pending: boolean }>('/api/auth/passkey/notice-email', { email: 'maya@example.com' }, token);
    expect(set.status).toBe(200);
    expect(set.data.pending).toBe(true);
    expect((await client.from('account_security').select('notice_email').single()).data!.notice_email).toBeNull();
    const tok = randomBytes(32).toString('base64url');
    await adminClient().from('notice_email_verifications').insert({ token_hash: createHash('sha256').update(tok).digest('hex'), user_id: userId, email: 'maya@example.com' });
    const getPage = await fetch(`${BASE}/api/auth/passkey/notice-email/verify?token=${tok}`);
    expect(getPage.status).toBe(200);   // GET only shows a button
    expect((await client.from('account_security').select('notice_email').single()).data!.notice_email).toBeNull();
    const confirm = await fetch(`${BASE}/api/auth/passkey/notice-email/verify?token=${tok}`, { method: 'POST' });
    expect(confirm.status).toBe(200);
    expect((await client.from('account_security').select('notice_email').single()).data!.notice_email).toBe('maya@example.com');
    expect((await fetch(`${BASE}/api/auth/passkey/notice-email/verify?token=${tok}`, { method: 'POST' })).status).toBe(410);
    expect((await call('/api/auth/passkey/notice-email', { email: null }, token)).status).toBe(200);
    expect((await client.from('account_security').select('notice_email').single()).data!.notice_email).toBeNull();
  }, 120_000);

  it('passphrase fallback: email-less account, sign-in by handle + passphrase', async () => {
    const h = `e2p${randomBytes(4).toString('hex')}`;
    const start = await call<{ challengeId: string; userId: string; email: string }>(
      '/api/auth/passkey/register/options', { handle: h, altcha: await altcha(), mode: 'passphrase' });
    expect(start.status).toBe(200);
    created.push(start.data.userId);
    const pass = 'correct horse battery staple orbit';
    const d = await deriveFromPassword(start.data.email, pass);
    const { bundle, unlocked } = createKeyBundle(start.data.userId, d.passwordKEK);
    const done = await call('/api/auth/passkey/register/verify', { challengeId: start.data.challengeId, bundle, authKey: d.authKey });
    expect(done.status).toBe(200);
    expect(done.data.tokenHash).toBeUndefined();
    // Sign in: look up the address by handle, derive, sign in, unlock.
    const look = await call<{ email: string }>('/api/auth/passkey/passphrase/lookup', { handle: h.toUpperCase() });
    expect(look.data.email).toBe(start.data.email);
    const decoy = await call<{ email: string }>('/api/auth/passkey/passphrase/lookup', { handle: `${h}x` });
    // Security review W3: decoys look exactly like real answers (an embedded version-4 UUID), and a passkey
    // account gets the same kind of answer as a passphrase account, so the lookup says nothing about the
    // account type; the password sign-in simply fails for it.
    expect(decoy.data.email).toMatch(/^u[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}@id\.kithwall\.invalid$/);
    const passkeyLook = await call<{ email: string }>('/api/auth/passkey/passphrase/lookup', { handle });
    expect(passkeyLook.data.email).toBe(`u${userId.replace(/-/g, '')}@id.kithwall.invalid`);
    const tryPasskey = await anonClient().auth.signInWithPassword({ email: passkeyLook.data.email, password: d.authKey });
    expect(tryPasskey.error).not.toBeNull();
    const client = anonClient();
    const d2 = await deriveFromPassword(look.data.email, pass);
    const si = await client.auth.signInWithPassword({ email: look.data.email, password: d2.authKey });
    expect(si.error).toBeNull();
    const b = (await client.from('key_bundles').select('bundle').single()).data!.bundle as KeyBundle;
    expect(Buffer.from(unlockWithPassword(start.data.userId, b, d2.passwordKEK).amk)).toEqual(Buffer.from(unlocked.amk));
  }, 120_000);

  it('ALTCHA proofs are single use', async () => {
    const pow = await altcha();
    const a = await call('/api/auth/passkey/register/options', { handle: `e2a${randomBytes(4).toString('hex')}`, altcha: pow, mode: 'passphrase' });
    expect(a.status).toBe(200);
    const b = await call('/api/auth/passkey/register/options', { handle: `e2b${randomBytes(4).toString('hex')}`, altcha: pow, mode: 'passphrase' });
    expect(b.status).toBe(400);
    expect((await call('/api/auth/passkey/register/options', { handle: 'abc123', altcha: 'nope', mode: 'passkey' })).status).toBe(400);
  }, 120_000);

  it('never mints sessions without a verified passkey', async () => {
    expect((await call('/api/auth/passkey/login/verify', { challengeId: randomUUID(), response: { id: 'x'.repeat(20), rawId: 'x'.repeat(20) } })).status).toBe(400);
  });
});
