// Security re-review R-K-1 (docs/v2/06-security-review.md §10.2), end to end against the LOCAL Supabase.
//
// The attack, exactly as the re-review describes it: someone with superuser access to the database
// (the operator, or whoever breaches it) disables profiles_guard, swaps a circle admin's published
// sign_pub/kx_pub for keys they hold, advances the circle's epoch with an audience_epochs record signed by
// the swapped key, and seals the new epoch key "from" the admin to a member. The member's device then reads
// everything through RLS and judges the delivery with the same functions lib/keys/keyring.ts uses
// (pinsCore.trustedKeysFor, authority.verifiedAdmins / judgeIncoming), starting from the pins it made when
// it first saw these people.
//
// Before the fix the member adopted the operator's key (asserted below as the "published key" control).
// Now: not adopted, and an identity ("safety number changed") warning is raised for the admin.
//
// Runs only when the local stack is up (apps/web/.env.local points at it and the database container
// answers); skipped otherwise. Creates and deletes its own users. Run: npx vitest run src/lib/keys/keyswap.e2e.test.ts
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  b64u, epochCommit, generateIdentity, newSymmetricKey, openSealed, seal, signAdminGrant, signEpochRecord,
  type Identity, type Sealed,
} from '@kithwall/crypto';
import { judgeIncoming, verifiedAdmins, type AudienceMeta, type EpochRecordRow, type GrantRow, type TrustedSigner } from './authority';
import { trustedKeysFor, type KeyChangeLogRow, type Pin } from './pinsCore';

function env(): Record<string, string> {
  try {
    return Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}
const E = env();
const CONTAINER = process.env.KW_DB_CONTAINER ?? 'supabase_db_kithwall';
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(E.NEXT_PUBLIC_SUPABASE_URL ?? '');

function psql(sql: string): string {
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { input: sql, encoding: 'utf8' });
}
async function stackUp(): Promise<boolean> {
  if (!local || !E.SUPABASE_SECRET_KEY) return false;
  try {
    const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, { headers: { apikey: E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' } });
    if (!r.ok) return false;
    return psql('select 1;').trim() === '1';
  } catch { return false; }
}
const up = await stackUp();
const run = up ? describe : describe.skip;

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;
const enc = (i: Identity) => ({ s: b64u.encode(i.signPub), x: b64u.encode(i.kxPub) });
const ctx = (aud: string, epoch: number, recipient: string) => `audience-key/${aud}/${epoch}/${recipient}`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Person { id: string; email: string; password: string; keys: Identity }

run('R-K-1: a superuser key swap does not get a circle to adopt the attacker\'s key', () => {
  const db = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SECRET_KEY!, noPersist);
  const created: string[] = [];
  const aud = randomUUID();
  const group = randomUUID();

  afterAll(async () => {
    await db.from('audiences').delete().eq('id', aud);
    for (const id of created) await db.auth.admin.deleteUser(id);
  });

  async function person(tag: string): Promise<Person> {
    const email = `keyswap-${tag}-${randomBytes(4).toString('hex')}@test.local`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? 'createUser');
    created.push(data.user.id);
    const keys = generateIdentity();
    const ins = await db.from('profiles').insert({ id: data.user.id, username: `ks${tag}${randomBytes(3).toString('hex')}`, sign_pub: enc(keys).s, kx_pub: enc(keys).x });
    if (ins.error) throw new Error(ins.error.message);
    return { id: data.user.id, email, password, keys };
  }

  async function signedIn(p: Person): Promise<SupabaseClient> {
    const c = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
    const { error } = await c.auth.signInWithPassword({ email: p.email, password: p.password });
    if (error) throw new Error(error.message);
    return c;
  }

  /** The member device's view of one delivery: everything read through RLS as the member. */
  async function judgeAsMember(member: Person, epoch: number, pins: Record<string, Pin>) {
    const c = await signedIn(member);
    const [a, m, r, k] = await Promise.all([
      c.from('audiences').select('id, kind, owner_id, current_epoch').eq('id', aud).single(),
      c.from('audience_members').select('member_id, role, status, grant_by, grant_sig').eq('audience_id', aud).eq('status', 'active'),
      c.from('audience_epochs').select('audience_id, epoch, rotated_by, commit, sig').eq('audience_id', aud).eq('epoch', epoch).maybeSingle(),
      c.from('audience_keys').select('epoch, sealed_by, sealed').eq('audience_id', aud).eq('epoch', epoch).eq('recipient_id', member.id).maybeSingle(),
    ]);
    if (a.error || m.error || r.error || k.error || !k.data) throw new Error(a.error?.message ?? m.error?.message ?? r.error?.message ?? k.error?.message ?? 'no delivery');
    const meta = a.data as AudienceMeta;
    const rows = m.data as (GrantRow & { status: string })[];
    const ids = [...new Set([meta.owner_id, ...rows.map((x) => x.member_id)])];
    const profs = new Map(((await c.from('profiles').select('id, sign_pub, kx_pub').in('id', ids)).data ?? [])
      .map((p) => [p.id as string, { s: p.sign_pub as string, x: p.kx_pub as string }]));
    const trusted = new Map<string, TrustedSigner & { published: string }>();
    for (const id of ids) {
      const pub = profs.get(id)!;
      const log = pins[id] && (pins[id]!.s !== pub.s || pins[id]!.x !== pub.x)
        ? ((await c.from('key_changes').select('change, sig, created_at').eq('user_id', id)).data ?? []) as KeyChangeLogRow[] : null;
      const t = trustedKeysFor(pins[id], pub, log);
      trusted.set(id, { s: t.s, trust: t.trust, published: pub.s });
    }
    await c.auth.signOut();
    const decide = (signer: (id: string) => TrustedSigner | null) => {
      const admins = verifiedAdmins(meta, rows, (id) => signer(id)?.s);
      return judgeIncoming({
        aud: meta, roster: { admins, members: new Set(rows.map((x) => x.member_id)) }, epoch, sealedBy: k.data!.sealed_by as string,
        record: (r.data as EpochRecordRow | null) ?? null, signer,
        open: (pub) => {
          try {
            return openSealed({ sealed: k.data!.sealed as Sealed, recipientKxPriv: member.keys.kxPriv, recipientKxPub: member.keys.kxPub,
              senderSignPub: b64u.decode(pub), context: ctx(aud, epoch, member.id) });
          } catch { return null; }
        },
      });
    };
    return {
      withPins: decide((id) => trusted.get(id) ?? null),
      /** What the client did before the fix: trust whatever the server publishes. */
      withPublished: decide((id) => (trusted.has(id) ? { s: trusted.get(id)!.published, trust: 'pinned' } : null)),
      trust: (id: string) => trusted.get(id)?.trust,
    };
  }

  it('replays the attack', { timeout: 60_000 }, async () => {
    const owner = await person('own');
    const admin = await person('adm');
    const member = await person('mem');

    // A circle owned by `owner`; `admin` was promoted with a signed grant; `member` is a member.
    must(await db.from('audiences').insert({ id: aud, owner_id: owner.id, kind: 'group' }));
    must(await db.from('groups').insert({ id: group, creator_id: owner.id, audience_id: aud, privacy: 'secret' }));
    must(await db.from('audience_members').insert([
      { audience_id: aud, member_id: owner.id, role: 'admin', status: 'active' },
      { audience_id: aud, member_id: admin.id, role: 'admin', status: 'active', grant_by: owner.id,
        grant_sig: signAdminGrant(owner.keys.signPriv, { audienceId: aud, memberId: admin.id, grantedBy: owner.id }) },
      { audience_id: aud, member_id: member.id, role: 'member', status: 'active' },
    ]));
    // Epoch 1, minted by the owner, delivered to the member.
    const key1 = newSymmetricKey();
    const c1 = epochCommit(aud, 1, key1);
    must(await db.from('audience_epochs').insert({ audience_id: aud, epoch: 1, rotated_by: owner.id, commit: c1,
      sig: signEpochRecord(owner.keys.signPriv, { audienceId: aud, epoch: 1, rotatedBy: owner.id, commit: c1 }) }));
    must(await db.from('audience_keys').insert({ audience_id: aud, epoch: 1, recipient_id: member.id, sealed_by: owner.id,
      sealed: seal({ recipientKxPub: member.keys.kxPub, senderSignPriv: owner.keys.signPriv, context: ctx(aud, 1, member.id), plaintext: key1 }) }));

    // The member's device met everyone before the attack: it pinned their keys (trust on first use).
    const at = new Date().toISOString();
    const pins: Record<string, Pin> = { [owner.id]: { ...enc(owner.keys), at }, [admin.id]: { ...enc(admin.keys), at } };
    const before = await judgeAsMember(member, 1, pins);
    expect(before.withPins).toMatchObject({ ok: true, via: 'record' });

    // ---- The superuser attack (re-review R-K-1) ----
    const evil = generateIdentity();
    const key2 = newSymmetricKey();
    const c2 = epochCommit(aud, 2, key2);
    const sig2 = signEpochRecord(evil.signPriv, { audienceId: aud, epoch: 2, rotatedBy: admin.id, commit: c2 });
    const sealed2 = seal({ recipientKxPub: member.keys.kxPub, senderSignPriv: evil.signPriv, context: ctx(aud, 2, member.id), plaintext: key2 });
    psql(`begin;
      alter table public.profiles disable trigger profiles_guard;
      update public.profiles set sign_pub = ${lit(enc(evil).s)}, kx_pub = ${lit(enc(evil).x)} where id = ${lit(admin.id)};
      alter table public.profiles enable trigger profiles_guard;
      update public.audiences set current_epoch = 2 where id = ${lit(aud)};
      insert into public.audience_epochs (audience_id, epoch, rotated_by, commit, sig) values (${lit(aud)}, 2, ${lit(admin.id)}, ${lit(c2)}, ${lit(sig2)});
      insert into public.audience_keys (audience_id, epoch, recipient_id, sealed_by, sealed)
        values (${lit(aud)}, 2, ${lit(member.id)}, ${lit(admin.id)}, ${lit(JSON.stringify(sealed2))}::jsonb);
      commit;`);

    const after = await judgeAsMember(member, 2, pins);
    // Control: trusting the published key, as clients did before, adopts the attacker's key.
    expect(after.withPublished).toMatchObject({ ok: true, via: 'record' });
    // With the pins: the admin's new key is unvouched (no key change signed by the pinned key), so the
    // delivery is NOT adopted and the device raises the safety-number warning for that admin.
    expect(after.trust(admin.id)).toBe('unvouched');
    expect(after.withPins.ok).toBe(false);
    expect(after.withPins).toMatchObject({ identity: admin.id });
    // The owner's legitimate key for epoch 1 is still adopted.
    expect((await judgeAsMember(member, 1, pins)).withPins).toMatchObject({ ok: true });
  });
});

function must<T extends { error: { message: string } | null }>(r: T): T {
  if (r.error) throw new Error(r.error.message);
  return r;
}
