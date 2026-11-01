// Key transparency end to end against the LOCAL Supabase (docs/v2/09-key-transparency.md): the proofs the
// database computes (SQL, 20261102000500_key_transparency.sql) verify with the TypeScript verifier every
// device uses (packages/crypto through lib/kt/core.ts), and the visibility rule holds through the API.
//
// Two accounts are created with real identity keys (sign-ups append two leaves, which stay in the local log
// for good: it is append-only), connected, and one looks up the other's key. Runs only when the local stack
// is up (apps/web/.env.local points at it); skipped otherwise. Run: npx vitest run src/lib/kt/kt.e2e.test.ts
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { b64u, generateIdentity } from '@kithwall/crypto';
import { headsConsistent, parseHead, verifyOpening, type KtHead } from './core';

function env(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}
const E = env();
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(E.NEXT_PUBLIC_SUPABASE_URL ?? '');
async function stackUp(): Promise<boolean> {
  if (!local || !E.SUPABASE_SECRET_KEY || !E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) return false;
  try {
    const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, { headers: { apikey: E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } });
    return r.ok;
  } catch { return false; }
}
const run = (await stackUp()) ? describe : describe.skip;
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

run('key-transparency log: SQL proofs verify on the device', () => {
  const admin = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);
  const anon = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
  const created: string[] = [];
  afterAll(async () => { for (const id of created) await admin.auth.admin.deleteUser(id); });

  async function head(size?: number): Promise<KtHead> {
    const { data, error } = await anon.rpc('kt_head', { p_size: size ?? null });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { size: number; root: string; created_at: string };
    return parseHead({ size: Number(row.size), root: row.root, at: row.created_at })!;
  }

  async function person(tag: string) {
    const email = `kt-${tag}-${randomBytes(4).toString('hex')}@test.local`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? 'createUser');
    created.push(data.user.id);
    const keys = generateIdentity();
    const signPub = b64u.encode(keys.signPub);
    const kxPub = b64u.encode(keys.kxPub);
    const ins = await admin.from('profiles').insert({ id: data.user.id, username: `kt${tag}${randomBytes(3).toString('hex')}`, sign_pub: signPub, kx_pub: kxPub });
    if (ins.error) throw new Error(ins.error.message);
    return { id: data.user.id, email, password, signPub, kxPub };
  }

  it('sign-ups extend the log consistently, and a contact\'s key is provably in it', async () => {
    const before = await head();
    const a = await person('a');
    const b = await person('b');
    const after = await head();
    expect(after.size).toBeGreaterThanOrEqual(before.size + 2);   // (other people may sign up meanwhile)

    const cons = await anon.rpc('kt_consistency', { p_from: before.size, p_to: after.size });
    expect(cons.error).toBeNull();
    expect(headsConsistent(before, after, cons.data)).toBe(true);
    // From size 1 too (the longest proof shape), and a tampered proof fails.
    const fromOne = await anon.rpc('kt_consistency', { p_from: 1, p_to: after.size });
    expect(headsConsistent(await head(1), after, fromOne.data)).toBe(true);
    expect(headsConsistent(before, after, [...(cons.data as string[]).slice(1)])).toBe(false);

    const link = await admin.from('friendships').insert({ user_a: a.id < b.id ? a.id : b.id, user_b: a.id < b.id ? b.id : a.id, status: 'accepted', requested_by: a.id, accepted_at: new Date().toISOString() });
    expect(link.error).toBeNull();

    const asA = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
    const login = await asA.auth.signInWithPassword({ email: a.email, password: a.password });
    expect(login.error).toBeNull();
    const stranger = await person('c');
    const res = await asA.rpc('kt_inclusion', {
      p_size: after.size,
      p_keys: [
        { user: b.id, signPub: b.signPub, kxPub: b.kxPub },
        { user: b.id, signPub: a.signPub, kxPub: b.kxPub },
        { user: stranger.id, signPub: stranger.signPub, kxPub: stranger.kxPub },
      ],
    });
    expect(res.error).toBeNull();
    const rows = res.data as { user_id: string; status: string; leaf_index: number; key_version: number; salt: string; proof: string[] }[];
    expect(rows.map((r) => r.status)).toEqual(['ok', 'missing', 'hidden']);
    const ok = rows[0]!;
    expect(Number(ok.leaf_index)).toBeGreaterThanOrEqual(before.size);
    const keys = { userId: b.id, signPub: b.signPub, kxPub: b.kxPub };
    const opening = { index: Number(ok.leaf_index), version: ok.key_version, salt: ok.salt, proof: ok.proof };
    expect(verifyOpening(after, keys, opening)).toBe(true);
    // A key the server might substitute does not verify with the same opening.
    expect(verifyOpening(after, { ...keys, signPub: a.signPub }, opening)).toBe(false);
    expect(rows[2]!.salt).toBeNull();

    // Deleting B removes the opening; the log keeps every entry.
    const sizeNow = (await head()).size;
    await admin.auth.admin.deleteUser(b.id);
    created.splice(created.indexOf(b.id), 1);
    const gone = await asA.rpc('kt_inclusion', { p_size: null, p_keys: [{ user: b.id, signPub: b.signPub, kxPub: b.kxPub }] });
    expect((gone.data as { status: string }[])[0]!.status).toBe('hidden');
    expect((await head()).size).toBeGreaterThanOrEqual(sizeNow);
    await asA.auth.signOut();
  }, 60_000);
});
