import 'server-only';
// The job behind Kithwall's automated accounts (docs/v2/13-official-accounts.md). It reads the public feeds
// the operator switched on and posts what is new as ordinary PUBLIC posts, signed with the account's own key.
// It runs a few times a day on a schedule, and whenever an admin presses "Post now".
//
// How an automated account differs from a person's account, and how it does not:
//  * its keys are made here and wrapped under a key derived from KITHWALL_OFFICIAL_SEED (a secret only the
//    operator holds). Without the seed this job does nothing, and nobody can sign in to these accounts: the
//    auth user has a random password and no passkey;
//  * to post, the job signs in AS the account and inserts through the same database rules as everyone
//    (the operator's public-posts switch, reports, moderation). It never writes a post with the secret key,
//    so an automated account can do nothing a person's account could not;
//  * it only ever writes public posts. It reads nothing about people.
import { createHash, hkdfSync, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { b64u, createKeyBundle, encryptFile, fileDigest, sealEnvelope, unlockWithPassword, type KeyBundle } from '@kithwall/crypto';
import { admin, asUser } from '../auth/server';
import { createAuthUser, deleteAuthUser, mintSessionToken } from '../auth/passkey-server';
import { postHeader } from '../postHeader';
import type { FileRef, PostPayload } from '../types';
import { MAX_IMAGE_BYTES, draftsFromFeed, draftsFromWikipedia, freshOrLatest, pickForAccount, spread, type Draft, type Source } from './compose';
import { parseFeed } from './feeds';
import { publicGet } from './fetch';
import { imageInfo } from './image';

interface AccountDef { slug: string; handle: string; name: string }

/** Most posts one account makes in one scheduled day, and in one "Post now". */
const ACCOUNT_CAP = 12;
/** "Post now" takes this many new items from each source, whatever was posted earlier today. */
const MANUAL_PER_SOURCE = 2;
/** Stop starting new work after this long; what is left is picked up by the next run. */
const BUDGET_MS = 45_000;
const FETCH_MS = 9_000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
/** "Today" for the daily limits (20 hours, so yesterday's run never holds back today's). */
const DAY_MS = 20 * 3600_000;
/** A scheduled run spreads what it found over the time until the next one. */
const SPREAD_HOURS = 3.5;

export interface RunOptions {
  /** An admin asked ("Post now"): post what is new at once, whatever the daily limits say. */
  manual?: boolean;
  /** Only this source. */
  only?: string;
}

export interface RunResult {
  ran: boolean;
  /** Why nothing ran: no seed configured, or the operator's switch is off. */
  reason?: 'not_configured' | 'switched_off';
  posted: number;
  accounts: { handle: string; posted: number; created?: boolean }[];
  /** Sources that were read and had nothing new. */
  quiet: string[];
  errors: { where: string; error: string }[];
}

function seed(): Buffer | null {
  const s = (process.env.KITHWALL_OFFICIAL_SEED ?? '').trim();
  return s.length >= 40 ? Buffer.from(s, 'utf8') : null;
}

/** The key that wraps one account's keys. Derived, never stored. */
function kekFor(ikm: Buffer, slug: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, Buffer.from('kithwall/v1/official'), Buffer.from(`kek/${slug}`), 32));
}

const itemKey = (draftKey: string) => createHash('sha256').update(draftKey).digest('base64url');

const short = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 280);

/** A source's feed, as text. Admin-added sources are addresses a person typed: public https hosts only. */
export async function fetchFeed(url: string): Promise<string> {
  const got = await publicGet(url, {
    accept: 'application/rss+xml, application/atom+xml, application/json, application/xml;q=0.9, */*;q=0.5',
    maxBytes: MAX_FEED_BYTES, timeoutMs: FETCH_MS,
  });
  return new TextDecoder('utf-8').decode(got.body);
}

/** Pictures come only from the publisher's own hosts, also after a redirect. */
const IMAGE_HOSTS: Record<string, RegExp> = {
  'nasa-image': /(^|\.)nasa\.gov$/i,
  wikipedia: /(^|\.)wikimedia\.org$/i,
};

async function fetchImage(kind: string, url: string): Promise<{ bytes: Uint8Array; mime: string; w: number; h: number } | null> {
  const allowed = IMAGE_HOSTS[kind];
  if (!allowed) return null;
  const got = await publicGet(url, {
    accept: 'image/jpeg, image/png, image/webp', maxBytes: MAX_IMAGE_BYTES, timeoutMs: FETCH_MS, hostOk: (h) => allowed.test(h),
  });
  const bytes = new Uint8Array(got.body);
  const info = imageInfo(bytes);
  return info ? { bytes, ...info } : null;
}

async function draftsFor(src: Source, now: number): Promise<Draft[]> {
  if (src.kind === 'wikipedia') {
    const day = new Date(now).toISOString().slice(0, 10);
    const url = `${src.url.replace(/\/+$/, '')}/${day.replace(/-/g, '/')}`;
    return draftsFromWikipedia(src, JSON.parse(await fetchFeed(url)) as unknown, day);
  }
  return freshOrLatest(draftsFromFeed(src, parseFeed(await fetchFeed(src.url))), now);
}

interface Signer { userId: string; signPriv: Uint8Array; created: boolean }

/** Opens the account's keys with the seed, creating the account the first time. */
async function ensureAccount(def: AccountDef, ikm: Buffer, existing: Map<string, string>): Promise<Signer> {
  const db = admin();
  const kek = kekFor(ikm, def.slug);
  const have = existing.get(def.slug);
  if (have) {
    const { data, error } = await db.from('key_bundles').select('bundle').eq('user_id', have).maybeSingle();
    if (error || !data) throw new Error(error?.message ?? 'the account has no keys');
    try {
      return { userId: have, signPriv: unlockWithPassword(have, data.bundle as KeyBundle, kek).identity.signPriv, created: false };
    } catch {
      throw new Error('KITHWALL_OFFICIAL_SEED does not open this account (was the seed changed?)');
    }
  }
  const userId = randomUUID();
  await createAuthUser(userId);
  const { bundle, unlocked } = createKeyBundle(userId, kek);
  const { error } = await db.rpc('create_official_account', {
    p_user: userId, p_slug: def.slug, p_handle: def.handle, p_name: def.name, p_bundle: bundle,
  });
  if (error) {
    await deleteAuthUser(userId);
    throw new Error(error.message);
  }
  existing.set(def.slug, userId);
  return { userId, signPriv: unlocked.identity.signPriv, created: true };
}

/** A database client that acts as the account: every rule that applies to a person applies to it. */
async function signInAs(userId: string): Promise<{ client: SupabaseClient; jwt: string }> {
  const hash = await mintSessionToken(userId);
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await anon.auth.verifyOtp({ token_hash: hash, type: 'magiclink' });
  const jwt = data.session?.access_token;
  if (error || !jwt) throw new Error(error?.message ?? 'could not sign in as the account');
  return { client: asUser(jwt), jwt };
}

/** Fetches a picture, encrypts it like any photo, uploads it into the account's folder. */
async function attachImage(client: SupabaseClient, userId: string, kind: string, url: string): Promise<FileRef | null> {
  const img = await fetchImage(kind, url).catch(() => null);
  if (!img) return null;
  const path = `${userId}/${randomUUID()}`;
  const { key, ciphertext } = encryptFile(img.bytes, path);
  const up = await client.storage.from('media').upload(path, new Blob([ciphertext as BlobPart], { type: 'application/octet-stream' }), {
    contentType: 'application/octet-stream', upsert: false,
  });
  if (up.error) return null;
  const reg = await client.from('media_objects').insert({ path, owner_id: userId, bytes: ciphertext.byteLength });
  if (reg.error) {
    await client.storage.from('media').remove([path]);
    return null;
  }
  return { path, key: b64u.encode(key), mime: img.mime, w: img.w, h: img.h, bytes: img.bytes.byteLength, sha: fileDigest(ciphertext) };
}

export async function runOfficial(opts: RunOptions = {}, now = Date.now()): Promise<RunResult> {
  const started = Date.now();
  const result: RunResult = { ran: false, posted: 0, accounts: [], quiet: [], errors: [] };
  const ikm = seed();
  if (!ikm) return { ...result, reason: 'not_configured' };
  const db = admin();
  const { data: sw } = await db.from('app_settings').select('value').eq('key', 'official_accounts_enabled').maybeSingle();
  if (sw?.value !== true) return { ...result, reason: 'switched_off' };
  result.ran = true;

  let srcQuery = db.from('official_sources')
    .select('id, account, kind, title, url, lang, terms, per_day, enabled, skip_title').eq('enabled', true).order('position');
  if (opts.only) srcQuery = srcQuery.eq('id', opts.only);
  const { data: srcRows, error: srcErr } = await srcQuery;
  if (srcErr) throw new Error(srcErr.message);
  const sources = (srcRows ?? []) as Source[];
  const { data: defRows, error: defErr } = await db.from('official_account_defs').select('slug, handle, name').order('created_at');
  if (defErr) throw new Error(defErr.message);
  const defs = (defRows ?? []) as AccountDef[];
  const { data: accRows, error: accErr } = await db.from('official_accounts').select('user_id, slug');
  if (accErr) throw new Error(accErr.message);
  const existing = new Map((accRows ?? []).map((r) => [r.slug as string, r.user_id as string]));

  // How much each source already posted today. A scheduled run keeps to each source's posts-a-day; "Post now"
  // is the operator asking, and takes a couple of new items from every source regardless.
  const postedToday = new Map<string, number>();
  if (!opts.manual) {
    const { data: recent, error: recentErr } = await db.from('official_items').select('source_id')
      .gt('created_at', new Date(Date.now() - DAY_MS).toISOString()).limit(5000);
    if (recentErr) throw new Error(recentErr.message);
    for (const r of recent ?? []) postedToday.set(r.source_id as string, (postedToday.get(r.source_id as string) ?? 0) + 1);
  }
  const allowance = (s: Source) => (opts.manual ? MANUAL_PER_SOURCE : Math.max(0, s.per_day - (postedToday.get(s.id) ?? 0)));

  // 1. Read every feed at once; leave out what was posted before.
  const read = await Promise.all(sources.map(async (source) => {
    const left = allowance(source);
    if (!left) return { source, drafts: [] as Draft[] };
    try {
      const drafts = await draftsFor(source, now);
      const keys = drafts.map((d) => itemKey(d.key));
      const seen = new Set<string>();
      if (keys.length) {
        const { data, error } = await db.from('official_items').select('item_key').eq('source_id', source.id).in('item_key', keys);
        if (error) throw new Error(error.message);
        for (const r of data ?? []) seen.add(r.item_key as string);
      }
      await db.from('official_sources').update({ last_run_at: new Date().toISOString(), last_error: null }).eq('id', source.id);
      const fresh = drafts.filter((d) => !seen.has(itemKey(d.key))).slice(0, left);
      if (!fresh.length) result.quiet.push(source.id);
      // The picker must not trim a manual run to the scheduled posts-a-day.
      return { source: opts.manual ? { ...source, per_day: left } : source, drafts: fresh };
    } catch (e) {
      result.errors.push({ where: source.id, error: short(e) });
      await db.from('official_sources').update({ last_run_at: new Date().toISOString(), last_error: short(e) }).eq('id', source.id);
      return { source, drafts: [] as Draft[] };
    }
  }));

  // 2. Each account posts its share, as itself.
  for (const def of defs) {
    if (Date.now() - started > BUDGET_MS) break;
    const today = opts.manual ? 0 : sources.filter((s) => s.account === def.slug).reduce((n, s) => n + (postedToday.get(s.id) ?? 0), 0);
    const picks = pickForAccount(read.filter((r) => r.source.account === def.slug && r.drafts.length), Math.max(0, ACCOUNT_CAP - today));
    if (!picks.length) continue;
    let jwt: string | null = null;
    const entry = { handle: def.handle, posted: 0 } as RunResult['accounts'][number];
    try {
      const signer = await ensureAccount(def, ikm, existing);
      if (signer.created) entry.created = true;
      const session = await signInAs(signer.userId);
      jwt = session.jwt;
      // "Post now" means now. A scheduled run spreads what it found until the next run.
      const times = opts.manual ? picks.map(() => null) : spread(picks.length, now, SPREAD_HOURS);
      for (let i = 0; i < picks.length; i++) {
        if (Date.now() - started > BUDGET_MS) break;
        const { source, draft } = picks[i]!;
        const key = itemKey(draft.key);
        // Claim the item first: a second run at the same moment then leaves it alone.
        const claim = await db.from('official_items').insert({ source_id: source.id, item_key: key });
        if (claim.error) {
          if (claim.error.code !== '23505') result.errors.push({ where: source.id, error: short(claim.error) });
          continue;
        }
        let image: FileRef | null = null;
        try {
          const id = randomUUID();
          if (draft.imageUrl) image = await attachImage(session.client, signer.userId, source.kind, draft.imageUrl);
          const payload: PostPayload = { text: draft.text, link: { ...draft.link, ...(image ? { image } : {}) } };
          const row = {
            id, author_id: signer.userId, wall_owner_id: signer.userId, group_id: null, event_id: null,
            kind: 'link' as const, is_public: true, audience_id: null, epoch: null, shared_post_id: null,
          };
          const envelope = sealEnvelope({ header: postHeader(row), payload, signPriv: signer.signPriv });
          const ins = await session.client.from('posts').insert({ ...row, envelope, ...(times[i] ? { publish_at: times[i] } : {}) });
          if (ins.error) throw new Error(ins.error.message);
          if (image) await session.client.from('media_objects').update({ post_id: id }).eq('path', image.path);
          await db.from('official_items').update({ post_id: id }).eq('source_id', source.id).eq('item_key', key);
          await db.from('official_sources').update({ last_posted_at: new Date().toISOString() }).eq('id', source.id);
          entry.posted++;
          result.posted++;
        } catch (e) {
          // Not posted: give the item back so the next run can try again, and leave no orphaned picture.
          await db.from('official_items').delete().eq('source_id', source.id).eq('item_key', key);
          if (image) {
            await session.client.storage.from('media').remove([image.path]);
            await session.client.from('media_objects').delete().eq('path', image.path);
          }
          result.errors.push({ where: `${def.handle} ← ${source.id}`, error: short(e) });
        }
      }
    } catch (e) {
      result.errors.push({ where: def.handle, error: short(e) });
    } finally {
      if (jwt) await db.auth.admin.signOut(jwt).catch(() => undefined);
    }
    result.accounts.push(entry);
  }

  const hk = await db.rpc('official_housekeeping');
  if (hk.error) result.errors.push({ where: 'housekeeping', error: short(hk.error) });
  return result;
}
