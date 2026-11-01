import { describe, expect, it } from 'vitest';
import { b64u, canonicalJson, encryptFile, generateIdentity, decryptFile, signDetached } from '@kithwall/crypto';
import {
  checkKitDrop, KITDROP_KIND, looksLikeKitDrop, MAX_MEDIA_ITEMS, mediaEntry, parseKitDrop, sha256, sigMessage, signKitDrop,
  type KitDropBody, type KitDropFile,
} from './kitdropFormat';
import type { PostRow } from '../types';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const fileId = (owner: string, n: number) => `${owner}/00000000-0000-4000-8000-00000000000${n}`;

function post(id: string, author: string): PostRow {
  return {
    id, author_id: author, wall_owner_id: author, group_id: null, event_id: null, kind: 'photo', is_public: false,
    audience_id: '33333333-3333-4333-8333-333333333333', epoch: 1, shared_post_id: null,
    envelope: { v: 1, sig: 'x', ct: 'y' } as unknown as PostRow['envelope'], created_at: '2026-11-01T10:00:00.000Z', edited_at: null,
  } as PostRow;
}

async function makeFile(signPriv: Uint8Array, opts: { media?: { path: string; bytes: Uint8Array }[]; posts?: PostRow[] } = {}): Promise<KitDropFile> {
  const media = await Promise.all((opts.media ?? []).map((m) => mediaEntry(m.path, m.bytes)));
  return signKitDrop({ v: 2, kind: KITDROP_KIND, from: ALICE, made: '2026-11-01T12:00:00.000Z', posts: opts.posts ?? [post('p1', ALICE)], media }, signPriv);
}

describe('Kit Drop files (v2)', () => {
  const alice = generateIdentity();
  const photo = encryptFile(new Uint8Array([1, 2, 3, 4, 5]), fileId(ALICE, 1));

  it('round-trips: the signature covers posts and photo hashes, and photos come back as ciphertext', async () => {
    const f = parseKitDrop(JSON.stringify(await makeFile(alice.signPriv, { media: [{ path: fileId(ALICE, 1), bytes: photo.ciphertext }] })));
    const c = await checkKitDrop(f, alice.signPub);
    expect(c.verified).toBe(true);
    expect(c.posts.map((p) => p.id)).toEqual(['p1']);
    expect(c.media).toHaveLength(1);
    // Still the stored ciphertext: only the key inside the (encrypted) post opens it.
    expect(decryptFile(c.media[0]!.cipher, photo.key, fileId(ALICE, 1))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('fails verification for another sender key, an altered post, or a changed photo list', async () => {
    const good = await makeFile(alice.signPriv, { media: [{ path: fileId(ALICE, 1), bytes: photo.ciphertext }] });
    expect((await checkKitDrop(good, generateIdentity().signPub)).verified).toBe(false);
    expect((await checkKitDrop(good, null)).verified).toBe(false);
    const altered = { ...good, posts: [{ ...good.posts[0]!, created_at: '2020-01-01T00:00:00.000Z' }] };
    expect((await checkKitDrop(altered, alice.signPub)).verified).toBe(false);
    const fewer = { ...good, media: [] };
    expect((await checkKitDrop(fewer, alice.signPub)).verified).toBe(false);
  });

  it('drops a photo whose bytes no longer match the signed hash, and says the file was altered', async () => {
    const good = await makeFile(alice.signPriv, { media: [{ path: fileId(ALICE, 1), bytes: photo.ciphertext }] });
    const tampered = new Uint8Array(photo.ciphertext);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    const bad = { ...good, media: [{ ...good.media![0]!, data: b64u.encode(tampered) }] };
    const c = await checkKitDrop(bad, alice.signPub);
    expect(c.verified).toBe(false);
    expect(c.media).toHaveLength(0);
  });

  it('keeps only photos in the folder of an author of a post in the file', async () => {
    const f = await makeFile(alice.signPriv, { media: [{ path: fileId(ALICE, 1), bytes: photo.ciphertext }, { path: fileId(BOB, 2), bytes: new Uint8Array([9]) }] });
    const c = await checkKitDrop(f, alice.signPub);
    expect(c.verified).toBe(true);
    expect(c.media.map((m) => m.path)).toEqual([fileId(ALICE, 1)]);
  });

  it('hashes with SHA-256 (base64url)', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('Kit Drop files: v1 and malformed input', () => {
  const alice = generateIdentity();

  it('still opens and verifies v1 files (no media)', async () => {
    const body: KitDropBody = { v: 1, kind: KITDROP_KIND, from: ALICE, made: '2026-10-30T09:00:00.000Z', posts: [post('p1', ALICE)] };
    const v1 = { ...body, sig: signDetached(canonicalJson({ d: 'kithwall/v1/kitdrop', v: 1, from: body.from, made: body.made, posts: body.posts }), alice.signPriv) };
    expect(sigMessage(body)).toBe(canonicalJson({ d: 'kithwall/v1/kitdrop', v: 1, from: body.from, made: body.made, posts: body.posts }));
    const c = await checkKitDrop(parseKitDrop(JSON.stringify(v1)), alice.signPub);
    expect(c.verified).toBe(true);
    expect(c.media).toEqual([]);
  });

  it('refuses anything that is not a Kit Drop', () => {
    expect(() => parseKitDrop('not json')).toThrow('not_kitdrop');
    expect(() => parseKitDrop(JSON.stringify({ kind: 'other', v: 2 }))).toThrow('not_kitdrop');
    expect(() => parseKitDrop(JSON.stringify({ v: 3, kind: KITDROP_KIND, from: ALICE, made: 'x', posts: [], sig: 's' }))).toThrow('not_kitdrop');
    const base = { v: 2, kind: KITDROP_KIND, from: ALICE, made: 'x', posts: [], sig: 's' };
    expect(() => parseKitDrop(JSON.stringify(base))).toThrow('not_kitdrop'); // v2 needs a media list
    expect(() => parseKitDrop(JSON.stringify({ ...base, media: [{ path: '../../etc/passwd', h: 'a', data: 'b' }] }))).toThrow('not_kitdrop');
    expect(() => parseKitDrop(JSON.stringify({ ...base, media: Array.from({ length: MAX_MEDIA_ITEMS + 1 }, (_, i) => ({ path: fileId(ALICE, i % 10), h: 'a', data: 'b' })) }))).toThrow('not_kitdrop');
    expect(() => parseKitDrop(JSON.stringify({ ...base, v: 1, media: [] }))).toThrow('not_kitdrop');
    expect(parseKitDrop(JSON.stringify({ ...base, media: [] })).v).toBe(2);
  });

  it('recognises a Kit Drop from the start of the file (for files handed over as "any file")', () => {
    expect(looksLikeKitDrop('{"v":2,"kind":"kithwall-kitdrop","from":"…')).toBe(true);
    expect(looksLikeKitDrop('  {"kind":"kithwall-kitdrop"')).toBe(true);
    expect(looksLikeKitDrop('PK\u0003\u0004 kithwall-kitdrop')).toBe(false);
    expect(looksLikeKitDrop('{"kind":"something-else"}')).toBe(false);
  });
});
