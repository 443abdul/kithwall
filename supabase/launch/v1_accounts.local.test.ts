// Launch rehearsal helper (docs/v2/07-launch.md §3): creates REAL v1-style accounts in the LOCAL Supabase stack,
// encrypted exactly the way the v1 app (tag v1-classic) wrote them, so the Kithwall 2 sign-in path and the
// "Kithwall Classic data" export can be walked through in a browser.
//
//   npx vitest run --root supabase/launch            (from the repo root, with `npx supabase start` running)
//
// Refuses to run unless apps/web/.env.local points at 127.0.0.1/localhost. Writes the test credentials it
// made up to KW_LAUNCH_ACCOUNTS (a JSON file path; default: the OS temp dir) — never into the repo.
//   ann  email + password, a friend (ben), every kind of Classic data: a poke, Kithville farm + a gift,
//        a friend list, a question with a vote, a check-in, a life event, a Kithville post, a Page with a post
//        and a liked Page, and a post ben wrote on her Wall
//   ben  ann's friend (his Page is the one ann liked)
//   mia  email + password with TOTP two-step verification (the secret is in the output file)
//   gus  confirmed email, never created keys (first sign-in must land on /setup)
//   fay  email NOT confirmed (sign-in must say so)
// Delete them afterwards with KW_LAUNCH_CLEANUP=1.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  b64u, createKeyBundle, deriveFromPassword, deriveSubkey, deriveVaultKey, encryptBlob, extractContentKey,
  newSymmetricKey, seal, sealEnvelope, sealWithContentKey, type EnvelopeHeader, type Unlocked,
} from '@kithwall/crypto';

const envFile = join(__dirname, '..', '..', 'apps', 'web', '.env.local');
const E: Record<string, string> = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const URL_ = E.NEXT_PUBLIC_SUPABASE_URL ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) throw new Error(`refusing to run against ${URL_}: local stack only`);
const OUT = process.env.KW_LAUNCH_ACCOUNTS ?? join(tmpdir(), 'kithwall-launch-accounts.json');
const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;
const admin = createClient(URL_, E.SUPABASE_SECRET_KEY!, noPersist);
const anon = () => createClient(URL_, E.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, noPersist);
const must = <T>(r: { data: T; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data; };

interface Account { name: string; id: string; email: string; password: string; db: SupabaseClient; u?: Unlocked; friends?: string; self?: string }
const keyCtx = (aud: string, epoch: number, recipient: string) => `audience-key/${aud}/${epoch}/${recipient}`;

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the MFA account. */
function totp(secretB32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function v1Account(name: string, opts: { confirmed?: boolean; keys?: boolean } = {}): Promise<Account> {
  const email = `launch-${name}-${randomBytes(3).toString('hex')}@example.com`;
  const password = `classic ${name} ${randomBytes(6).toString('hex')} password`;
  const d = await deriveFromPassword(email, password);
  const cu = await admin.auth.admin.createUser({ email, password: d.authKey, email_confirm: opts.confirmed !== false });
  if (cu.error) throw new Error(cu.error.message);
  const id = cu.data.user!.id;
  const db = anon();
  const acct: Account = { name, id, email, password, db };
  if (opts.confirmed === false || opts.keys === false) return acct;
  must(await db.auth.signInWithPassword({ email, password: d.authKey }));
  // v1 /welcome: create keys, upload the bundle, create the profile (lib/keys/session.ts completeSetup).
  const { bundle, unlocked } = createKeyBundle(id, d.passwordKEK);
  must(await db.from('key_bundles').insert({ user_id: id, bundle }));
  must(await db.from('profiles').insert({ id, username: `launch${name}${randomBytes(2).toString('hex')}`, sign_pub: bundle.signPub, kx_pub: bundle.kxPub }));
  acct.u = unlocked;
  const auds = must(await db.from('audiences').select('id, kind').eq('owner_id', id)) as { id: string; kind: string }[];
  acct.friends = auds.find((a) => a.kind === 'friends')!.id;
  acct.self = auds.find((a) => a.kind === 'self')!.id;
  return acct;
}

/** Seal an audience key to a recipient, signed by `by` (keyring.storeFor). */
async function deliver(by: Account, aud: string, epoch: number, to: { id: string; kxPub: Uint8Array }, key: Uint8Array) {
  const sealed = seal({ recipientKxPub: to.kxPub, senderSignPriv: by.u!.identity.signPriv, context: keyCtx(aud, epoch, to.id), plaintext: key });
  must(await by.db.from('audience_keys').insert({ audience_id: aud, epoch, recipient_id: to.id, sealed_by: by.id, sealed }));
}
const me = (a: Account) => ({ id: a.id, kxPub: a.u!.identity.kxPub });

function postHeader(p: { id: string; author_id: string; wall_owner_id?: string | null; page_id?: string | null; kind: string; is_public: boolean; audience_id: string | null; epoch: number | null }): EnvelopeHeader {
  const wall = p.wall_owner_id ?? p.page_id ?? undefined;
  return { v: 1, type: `post:${p.kind}`, id: p.id, author: p.author_id, ...(wall ? { wall } : {}), audience: p.is_public ? 'public' : { id: p.audience_id!, epoch: p.epoch! } };
}
async function post(by: Account, row: { wall_owner_id?: string; page_id?: string; kind: string; audience: string | null; key: Uint8Array | null }, payload: unknown) {
  const r = {
    id: crypto.randomUUID(), author_id: by.id, wall_owner_id: row.page_id ? null : row.wall_owner_id ?? by.id, page_id: row.page_id ?? null,
    kind: row.kind, is_public: row.audience === null, audience_id: row.audience, epoch: row.audience ? 1 : null,
  };
  const envelope = sealEnvelope({ header: postHeader(r), payload, audienceKey: row.key ?? undefined, signPriv: by.u!.identity.signPriv });
  const db = row.page_id ? admin : by.db;   // Page posts need the Public switch, which Kithwall 2 keeps off
  must(await db.from('posts').insert({ ...r, envelope }));
  return { ...r, envelope };
}

const run = process.env.KW_LAUNCH_CLEANUP ? describe.skip : describe;

run('local v1 accounts for the launch walk-through', () => {
  it('creates ann, ben, mia, gus and fay with Classic data', async () => {
    const ann = await v1Account('ann');
    const ben = await v1Account('ben');
    const mia = await v1Account('mia');
    const gus = await v1Account('gus', { keys: false });
    const fay = await v1Account('fay', { confirmed: false });

    // Own audience keys (keyring.ensureOwn), friendship, friend keys both ways.
    const annFriendsKey = newSymmetricKey(); const annSelfKey = newSymmetricKey(); const benFriendsKey = newSymmetricKey();
    await deliver(ann, ann.friends!, 1, me(ann), annFriendsKey);
    await deliver(ann, ann.self!, 1, me(ann), annSelfKey);
    await deliver(ben, ben.friends!, 1, me(ben), benFriendsKey);
    await deliver(ben, ben.self!, 1, me(ben), newSymmetricKey());
    await deliver(mia, mia.friends!, 1, me(mia), newSymmetricKey());
    await deliver(mia, mia.self!, 1, me(mia), newSymmetricKey());
    const [a, b] = ann.id < ben.id ? [ann.id, ben.id] : [ben.id, ann.id];
    must(await ann.db.from('friendships').insert({ user_a: a, user_b: b, requested_by: ann.id }));
    must(await ben.db.from('friendships').update({ status: 'accepted' }).match({ user_a: a, user_b: b }));
    await deliver(ann, ann.friends!, 1, me(ben), annFriendsKey);
    await deliver(ben, ben.friends!, 1, me(ann), benFriendsKey);

    // Pokes: ben poked ann.
    must(await ben.db.from('pokes').insert({ from_id: ben.id, to_id: ann.id }));

    // Kithville: ann's farm (vault key) and a gift from ben (sealed to ann).
    const farm = { v: 1, coins: 1234, xp: 300, plots: [{ c: 'carrot', t0: Date.now() - 60_000 }, null], sel: 'carrot', animals: [], helped: {}, gifted: {}, log: [{ t: Date.now(), text: 'Harvested 3 carrots' }] };
    must(await ann.db.from('game_state').insert({ user_id: ann.id, blob: encryptBlob(deriveVaultKey(ann.u!.amk), new TextEncoder().encode(JSON.stringify(farm)), `kithville/${ann.id}`), version: 1 }));
    const giftId = crypto.randomUUID();
    must(await ben.db.from('game_actions').insert({
      id: giftId, from_id: ben.id, to_id: ann.id, kind: 'gift',
      sealed: seal({ recipientKxPub: ann.u!.identity.kxPub, senderSignPriv: ben.u!.identity.signPriv, context: `kithville/gift/${giftId}/${ann.id}`, plaintext: new TextEncoder().encode(JSON.stringify({ kind: 'gift', item: 'cow', note: 'moo' })) }),
    }));

    // Friend list "Close friends" with ben (name under ann's vault key).
    const list = must(await ann.db.from('audiences').insert({ owner_id: ann.id, kind: 'list',
      name_enc: { v: 1, b: encryptBlob(deriveVaultKey(ann.u!.amk), new TextEncoder().encode('Close friends'), `list-name/${ann.id}`) } }).select('id').single()) as { id: string };
    must(await ann.db.from('audience_members').insert({ audience_id: list.id, member_id: ben.id, status: 'active', role: 'member' }));
    const listKey = newSymmetricKey();
    await deliver(ann, list.id, 1, me(ann), listKey);
    await deliver(ann, list.id, 1, me(ben), listKey);

    // Posts: a question (ben votes), a check-in, a life event, a Kithville post, a status to the list; ben on ann's Wall.
    const q = await post(ann, { kind: 'question', audience: ann.friends!, key: annFriendsKey }, { question: { text: 'Best pizza topping?', options: ['Mushrooms', 'Olives'], allowAdd: true } });
    const ck = extractContentKey({ header: postHeader(q), envelope: q.envelope, audienceKey: annFriendsKey });
    const voteHeader: EnvelopeHeader = { v: 1, type: 'poll_vote', id: q.id, author: ben.id, wall: q.id, audience: 'self' };
    must(await ben.db.from('poll_votes').insert({ post_id: q.id, voter_id: ben.id,
      envelope: sealWithContentKey({ header: voteHeader, payload: { choice: 'Olives' }, contentKey: deriveSubkey(ck, 'vote', ben.id), signPriv: ben.u!.identity.signPriv }) }));
    await post(ann, { kind: 'checkin', audience: ann.friends!, key: annFriendsKey }, { text: 'Lunch!', checkin: { place: 'Classic Diner', with: [ben.id] } });
    await post(ann, { kind: 'life_event', audience: ann.friends!, key: annFriendsKey }, { lifeEvent: { kind: 'job', title: 'Started at the bakery' } });
    await post(ann, { kind: 'game', audience: ann.friends!, key: annFriendsKey }, { game: { app: 'kithville', text: 'Ann reached level 6 in Kithville!' } });
    await post(ann, { kind: 'status', audience: list.id, key: listKey }, { text: 'Only for close friends' });
    await post(ben, { kind: 'status', wall_owner_id: ann.id, audience: ann.friends!, key: annFriendsKey }, { text: 'Happy birthday Ann!' });

    // Pages (public data; created with the service key because Kithwall 2 keeps the Public switch off).
    const annPage = must(await admin.from('pages').insert({ owner_id: ann.id, name: 'Ann\'s Bakery', category: 'Local Business', about: 'Fresh bread.' }).select('id').single()) as { id: string };
    const benPage = must(await admin.from('pages').insert({ owner_id: ben.id, name: 'Ben\'s Band', category: 'Music', about: null }).select('id').single()) as { id: string };
    must(await admin.from('page_likes').insert([{ page_id: benPage.id, user_id: ann.id }, { page_id: annPage.id, user_id: ben.id }]));
    await post(ann, { kind: 'status', page_id: annPage.id, audience: null, key: null }, { text: 'Sourdough on Saturdays' });

    // Mia turns on TOTP (v1 Settings → Security).
    const mf = must(await mia.db.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'phone' })) as { id: string; totp: { secret: string } };
    must(await mia.db.auth.mfa.challengeAndVerify({ factorId: mf.id, code: totp(mf.totp.secret) }));

    const out = Object.fromEntries([ann, ben, mia, gus, fay].map((x) => [x.name, { id: x.id, email: x.email, password: x.password }]));
    writeFileSync(OUT, JSON.stringify({ ...out, mia: { ...out.mia, totpSecret: mf.totp.secret }, createdAt: new Date().toISOString() }, null, 2));
    expect(Object.keys(out)).toHaveLength(5);
  }, 180_000);
});

(process.env.KW_LAUNCH_CLEANUP ? describe : describe.skip)('cleanup', () => {
  it('deletes the accounts listed in the output file', async () => {
    const made = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, { id?: string }>;
    for (const v of Object.values(made)) if (v?.id) await admin.auth.admin.deleteUser(v.id);
    expect(true).toBe(true);
  });
});

/** For the walk-through: current TOTP code for mia (KW_TOTP_SECRET=… npx vitest run --root supabase/launch -t totp). */
(process.env.KW_TOTP_SECRET ? describe : describe.skip)('totp', () => {
  it('prints the current code', () => { console.log('TOTP', totp(process.env.KW_TOTP_SECRET!)); expect(true).toBe(true); });
});
