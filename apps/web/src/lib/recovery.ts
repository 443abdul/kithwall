'use client';
// Trusted-friend recovery (spec §3.5). Both sides live here so the seal contexts always match:
//   share sealed to a trustee:   recovery-share/<ownerId>/<trusteeId>/<setupId>   (signed by the owner)
//   share released to the owner: recovery-release/<requestId>/<trusteeId>         (signed by the trustee)
// The owner's new device keeps the ephemeral private key E in IndexedDB, wrapped by a non-extractable
// WebCrypto key, until the request completes.
import {
  b64u, openSealed, recoveryKeyFromPhrase, seal, splitRecoveryKey, unlockWithRecoveryKey, verificationPhrase, type Sealed,
} from '@kithwall/crypto';
import { sb, must } from './supabase';
import { fetchBundle, getSession, identity, me } from './keys/session';
import { people } from './people';

export const shareContext = (ownerId: string, trusteeId: string, setupId: string) => `recovery-share/${ownerId}/${trusteeId}/${setupId}`;
export const releaseContext = (requestId: string, trusteeId: string) => `recovery-release/${requestId}/${trusteeId}`;

export const MIN_TRUSTEES = 3;
export const MAX_TRUSTEES = 5;

export interface ShareRow { owner_id: string; trustee_id: string; setup_id: string; threshold: number; sealed: Sealed; created_at: string }
export interface RequestRow { id: string; owner_id: string; eph_pub: string; status: 'pending' | 'cancelled' | 'completed'; not_before: string; expires_at: string; created_at: string }
export interface ResponseRow { request_id: string; trustee_id: string; sealed: Sealed; created_at: string }

export const phraseFor = (r: Pick<RequestRow, 'id' | 'eph_pub'>) => verificationPhrase(r.id, b64u.decode(r.eph_pub));

// ---------------------------------------------------------------------------------------
// Owner: choose trusted friends

/** My current trusted friends (one row each; same setup id and threshold). */
export async function myTrustees(): Promise<ShareRow[]> {
  const rows = must(await sb().from('recovery_shares').select('*').eq('owner_id', me())) as ShareRow[];
  await people.ensure(rows.map((r) => r.trustee_id));
  return rows;
}

/** Check a typed 24-word phrase against my bundle and return RK (throws if wrong). */
export async function rkFromPhrase(phrase: string): Promise<Uint8Array> {
  const bundle = await fetchBundle(me());
  if (!bundle) throw new Error('No keys found for this account');
  const rk = recoveryKeyFromPhrase(phrase);
  unlockWithRecoveryKey(me(), bundle, rk); // throws bad_phrase / decrypt_failed if it isn't mine
  return rk;
}

/**
 * Split RK k-of-n, seal each share to a friend (signed by me) and replace any previous setup.
 * Wipes `rk` when done. Each trustee gets an in-app notification.
 */
export async function setupTrustees(rk: Uint8Array, trusteeIds: string[], threshold: number): Promise<void> {
  const ids = [...new Set(trusteeIds)];
  try {
    if (ids.length < MIN_TRUSTEES || ids.length > MAX_TRUSTEES) throw new Error(`Choose between ${MIN_TRUSTEES} and ${MAX_TRUSTEES} friends.`);
    if (threshold < 2 || threshold > ids.length) throw new Error('The number of friends needed must be between 2 and the number you chose.');
    if (ids.includes(me())) throw new Error('You can\'t be your own trusted friend.');
    await people.ensure(ids);
    const shares = await splitRecoveryKey(rk, ids.length, threshold);
    const setupId = crypto.randomUUID();
    const rows = ids.map((t, i) => {
      const p = people.get(t);
      if (!p) throw new Error('One of those friends could not be found.');
      const sealed = seal({ recipientKxPub: b64u.decode(p.kx_pub), senderSignPriv: identity().signPriv, context: shareContext(me(), t, setupId), plaintext: shares[i]! });
      shares[i]!.fill(0);
      return { owner_id: me(), trustee_id: t, setup_id: setupId, threshold, sealed };
    });
    const previous = (await myTrustees()).map((r) => r.trustee_id);
    must(await sb().from('recovery_shares').delete().eq('owner_id', me()));
    must(await sb().from('recovery_shares').insert(rows));
    for (const t of ids) {
      if (previous.includes(t)) continue;
      await sb().from('notifications').insert({ recipient_id: t, actor_id: me(), type: 'recovery_trustee', object_kind: 'profile', object_id: me() });
    }
  } finally {
    rk.fill(0);
  }
}

export async function removeTrustees(): Promise<void> {
  must(await sb().from('recovery_shares').delete().eq('owner_id', me()));
}

/** After a new recovery key is generated: re-split it to the same friends with the same threshold. */
export async function resplitToSameTrustees(rk: Uint8Array): Promise<boolean> {
  const cur = await myTrustees();
  if (cur.length < MIN_TRUSTEES) { rk.fill(0); return false; }
  await setupTrustees(rk, cur.map((r) => r.trustee_id), cur[0]!.threshold);
  return true;
}

// ---------------------------------------------------------------------------------------
// Owner: recover on a new device (in the session opened by the password-reset email)

const DB = 'kithwall-recovery';
const STORE = 'eph';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(db.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}

interface StoredEph { requestId: string; userId: string; key: CryptoKey; iv: Uint8Array; ct: ArrayBuffer }
const ephAad = (userId: string, requestId: string) => new TextEncoder().encode(`kithwall/v1/recovery-eph/${userId}/${requestId}`);

export async function storeEph(userId: string, requestId: string, priv: Uint8Array) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ephAad(userId, requestId) }, key, priv as BufferSource);
  await idbDo('readwrite', (s) => s.put({ requestId, userId, key, iv, ct } satisfies StoredEph, requestId));
}

export async function loadEph(userId: string, requestId: string): Promise<Uint8Array | null> {
  const rec = await idbDo<StoredEph | undefined>('readonly', (s) => s.get(requestId)).catch(() => undefined);
  if (!rec || rec.userId !== userId) return null;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: ephAad(userId, requestId) }, rec.key, rec.ct);
  return new Uint8Array(pt);
}

export async function dropEph(requestId: string) { await idbDo('readwrite', (s) => s.delete(requestId)).catch(() => undefined); }


export async function cancelRequest(id: string): Promise<void> {
  must(await sb().from('recovery_requests').update({ status: 'cancelled' }).eq('id', id));
  await dropEph(id);
}

export function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  const n = Math.min(xs.length, 8);
  for (let m = 1; m < 1 << n; m++) out.push(xs.slice(0, n).filter((_, i) => m & (1 << i)));
  return out;
}

// ---------------------------------------------------------------------------------------
// Trustee: requests from friends who chose me

export interface IncomingRequest extends RequestRow { share: ShareRow; responded: boolean }

export async function incomingRecoveryRequests(): Promise<IncomingRequest[]> {
  const myId = me();
  const shares = must(await sb().from('recovery_shares').select('*').eq('trustee_id', myId)) as ShareRow[];
  if (!shares.length) return [];
  const reqs = must(await sb().from('recovery_requests').select('*').in('owner_id', shares.map((s) => s.owner_id))
    .eq('status', 'pending').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false })) as RequestRow[];
  if (!reqs.length) return [];
  const mine = must(await sb().from('recovery_responses').select('request_id').eq('trustee_id', myId).in('request_id', reqs.map((r) => r.id))) as { request_id: string }[];
  await people.ensure(reqs.map((r) => r.owner_id));
  return reqs.map((r) => ({ ...r, share: shares.find((s) => s.owner_id === r.owner_id)!, responded: mine.some((m) => m.request_id === r.id) }));
}

/** Who I'm a trusted friend for (no request needed). */
export async function trustedBy(): Promise<string[]> {
  const rows = must(await sb().from('recovery_shares').select('owner_id').eq('trustee_id', me())) as { owner_id: string }[];
  await people.ensure(rows.map((r) => r.owner_id));
  return rows.map((r) => r.owner_id);
}

/** Decrypt my share (verifying the owner's signature) and re-seal it to the request's ephemeral key. */
export async function approveRecovery(req: IncomingRequest): Promise<void> {
  if (Date.now() < new Date(req.not_before).getTime()) throw new Error('The waiting period isn\'t over yet.');
  const owner = people.get(req.owner_id);
  if (!owner) throw new Error('Could not load your friend\'s keys.');
  const id = identity();
  const share = openSealed({
    sealed: req.share.sealed, recipientKxPriv: id.kxPriv, recipientKxPub: id.kxPub,
    senderSignPub: b64u.decode(owner.sign_pub), context: shareContext(req.owner_id, me(), req.share.setup_id),
  });
  try {
    const sealed = seal({ recipientKxPub: b64u.decode(req.eph_pub), senderSignPriv: id.signPriv, context: releaseContext(req.id, me()), plaintext: share });
    must(await sb().from('recovery_responses').insert({ request_id: req.id, trustee_id: me(), sealed }));
  } finally {
    share.fill(0);
  }
}

export function ready(): boolean { return getSession().status === 'ready'; }
