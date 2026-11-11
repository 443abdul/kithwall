import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSearchKey, newSymmetricKey, searchRecordName } from '@kithwall/crypto';
import { deleteSearchDatabase, MAX_TEXT, SearchIndex, type SearchDoc } from './store';

// ---------------------------------------------------------------------------------------------
// A small in-memory IndexedDB: just what the index uses (one store, put / delete / getAll / getAllKeys,
// transactions that complete, deleteDatabase). Requests answer asynchronously, like the real thing.
const databases = new Map<string, Map<string, unknown>>();
type Req<T> = { result: T; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded?: (() => void) | null; onblocked?: (() => void) | null };
function request<T>(compute: () => T, upgrade = false): Req<T> {
  const r: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  setTimeout(() => { r.result = compute(); if (upgrade) r.onupgradeneeded?.(); r.onsuccess?.(); }, 0);
  return r;
}
const fakeIndexedDB = {
  open(name: string) {
    const isNew = !databases.has(name);
    return request(() => {
      if (!databases.has(name)) databases.set(name, new Map());
      const data = databases.get(name)!;
      return {
        createObjectStore: () => undefined,
        close: () => undefined,
        transaction() {
          const tx = { oncomplete: null as (() => void) | null, onerror: null, onabort: null, error: null,
            objectStore: () => ({
              put: (value: unknown, key: string) => request(() => { data.set(key, value); return key; }),
              delete: (key: string) => request(() => { data.delete(key); return undefined; }),
              getAll: () => request(() => [...data.values()]),
              getAllKeys: () => request(() => [...data.keys()]),
            }) };
          setTimeout(() => tx.oncomplete?.(), 5);
          return tx;
        },
      };
    }, isNew);
  },
  deleteDatabase(name: string) { return request(() => { databases.delete(name); return undefined; }); },
};

const USER = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const msg = (n: number, text: string, extra: Partial<SearchDoc> = {}): SearchDoc => ({
  id: `m:0000000${n}-0000-4000-8000-000000000000`, kind: 'message', ctx: CHAT, author: USER,
  at: `2026-11-0${n}T10:00:00.000000+00:00`, text, ...extra,
});
const stored = () => databases.get('kw-search') ?? new Map<string, unknown>();

beforeEach(() => { databases.clear(); vi.stubGlobal('indexedDB', fakeIndexedDB); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('search index', () => {
  it('finds what was noted, newest first, and nothing while closed', async () => {
    const amk = newSymmetricKey();
    const index = new SearchIndex();
    index.note(msg(1, 'ignored: the index is not open'));
    expect(await index.search('ignored')).toEqual([]);
    index.open(USER, amk);
    index.note(msg(1, 'Dinner at the Karachi Kitchen'));
    index.note(msg(2, 'karachi again, لقاء في الكراچی'));
    index.note({ ...msg(3, 'A post about Karachi'), id: 'p:3', kind: 'post', ctx: 'p3' });
    const hits = await index.search('karachi');
    expect(hits.map((h) => h.doc.id)).toEqual(['p:3', msg(2, '').id, msg(1, '').id]);
    expect((await index.search('karachi', { kinds: ['message'] })).length).toBe(2);
    expect((await index.search('karachi', { ctx: 'p3' })).map((h) => h.doc.id)).toEqual(['p:3']);
    expect((await index.search('karachi', { exclude: (d) => d.ctx === CHAT })).map((h) => h.doc.id)).toEqual(['p:3']);
    expect((await index.search('karachi', { limit: 1 })).length).toBe(1);
    expect((await index.search('كراچي')).map((h) => h.doc.id)).toEqual([msg(2, '').id]);
    expect(await index.search('lahore')).toEqual([]);
    expect(await index.search(' ')).toEqual([]);
    index.close();
    expect(await index.search('karachi')).toEqual([]);
  });

  it('keeps nothing readable at rest: opaque names, ciphertext, padded sizes', async () => {
    const amk = newSymmetricKey();
    const index = new SearchIndex();
    index.open(USER, amk);
    index.note(msg(1, 'the secret word is pomegranate'));
    index.note(msg(2, 'x'));
    await index.flush();
    const rows = [...stored().entries()];
    expect(rows).toHaveLength(2);
    const key = deriveSearchKey(amk);
    expect(rows.map(([name]) => name).sort()).toEqual([searchRecordName(key, msg(1, '').id), searchRecordName(key, msg(2, '').id)].sort());
    for (const [name, blob] of rows) {
      expect(typeof blob).toBe('string');
      const all = `${name} ${blob as string}`;
      for (const leak of ['pomegranate', 'secret', CHAT, USER, '00000001-0000', 'message']) expect(all).not.toContain(leak);
    }
  });

  it('pads records, so texts of similar length look the same size', async () => {
    const index = new SearchIndex();
    index.open(USER, newSymmetricKey());
    index.note(msg(1, 'a'));
    index.note(msg(2, 'abcdefghij'));
    index.note(msg(3, 'a much longer message that needs more room than the short ones do, by a good margin, really'));
    await index.flush();
    const sizes = [...stored().values()].map((blob) => (blob as string).length).sort((a, b) => a - b);
    expect(sizes[0]).toBe(sizes[1]);
    expect(sizes[2]!).toBeGreaterThan(sizes[1]!);
    // Steps of 64 bytes (base64url: 4 characters per 3 bytes).
    expect((sizes[2]! - sizes[1]!) % 4).toBeLessThan(4);
  });

  it('reads the index back after a lock, only with the same account key', async () => {
    const amk = newSymmetricKey();
    const first = new SearchIndex();
    first.open(USER, amk);
    first.note(msg(1, 'remember the pomegranate'));
    await first.flush();
    first.close();

    const again = new SearchIndex();
    again.open(USER, amk);
    expect(again.isLoaded).toBe(false);
    expect((await again.search('pomegranate')).map((h) => h.doc.text)).toEqual(['remember the pomegranate']);
    expect(again.size).toBe(1);

    // Another key (another account on this device, or a guess): nothing opens, and the unreadable records go.
    const other = new SearchIndex();
    other.open(USER, newSymmetricKey());
    expect(await other.search('pomegranate')).toEqual([]);
    expect(stored().size).toBe(0);
    // The right key under another account id doesn't open them either (records are bound to the account).
    again.note(msg(2, 'another pomegranate'));
    await again.flush();
    const wrongUser = new SearchIndex();
    wrongUser.open('99999999-9999-4999-8999-999999999999', amk);
    expect(await wrongUser.search('pomegranate')).toEqual([]);
  });

  it('replaces an edited message and removes an unsent one', async () => {
    const index = new SearchIndex();
    index.open(USER, newSymmetricKey());
    index.note(msg(1, 'meet at the bridge'));
    index.note(msg(2, 'second message about the bridge'));
    expect((await index.search('bridge')).length).toBe(2);
    index.note(msg(1, 'meet at the station'));          // edited
    index.forget([msg(2, '').id]);                       // unsent
    expect(await index.search('bridge')).toEqual([]);
    expect((await index.search('station')).map((h) => h.doc.id)).toEqual([msg(1, '').id]);
    expect(stored().size).toBe(1);
    index.note(msg(1, '   '));                           // edited down to nothing (photo only)
    expect(await index.search('station')).toEqual([]);
    expect(stored().size).toBe(0);
  });

  it('removes by rule: a chat that was left, a post with its comments, a blocked author', async () => {
    const index = new SearchIndex();
    index.open(USER, newSymmetricKey());
    index.note(msg(1, 'apple in chat one'));
    index.note(msg(2, 'apple in chat two', { ctx: 'other-chat' }));
    index.note({ id: 'p:1', kind: 'post', ctx: 'post1', author: 'bob', at: '2026-11-03T00:00:00+00:00', text: 'apple post' });
    index.note({ id: 'c:1', kind: 'comment', ctx: 'post1', author: USER, at: '2026-11-03T01:00:00+00:00', text: 'apple comment' });
    await index.forgetWhere((d) => d.kind === 'message' && d.ctx === CHAT);
    expect((await index.search('apple')).map((h) => h.doc.id).sort()).toEqual(['c:1', msg(2, '').id, 'p:1'].sort());
    await index.forgetWhere((d) => d.kind !== 'message' && d.author === 'bob');
    expect((await index.search('apple')).map((h) => h.doc.id).sort()).toEqual(['c:1', msg(2, '').id].sort());
    expect(await index.idsWhere((d) => d.ctx === 'post1')).toEqual(['c:1']);
  });

  it('lets disappearing messages leave when their time is up', async () => {
    const index = new SearchIndex();
    index.open(USER, newSymmetricKey());
    const soon = new Date(Date.now() + 60_000).toISOString();
    index.note(msg(1, 'this disappears', { exp: soon }));
    index.note(msg(2, 'this stays'));
    index.note(msg(3, 'this is already gone', { exp: new Date(Date.now() - 1000).toISOString() }));
    expect((await index.search('this')).map((h) => h.doc.id)).toEqual([msg(2, '').id, msg(1, '').id]);
    // Its time passes: not found any more, and the sweep deletes the record.
    index.sweep(Date.now() + 120_000);
    await index.flush();
    expect((await index.search('this')).map((h) => h.doc.id)).toEqual([msg(2, '').id]);
    expect(stored().size).toBe(1);
    // An expired record still on disk at the next unlock is dropped while loading, never shown.
  });

  it('deletes everything on destroy, and a wipe needs no key', async () => {
    const amk = newSymmetricKey();
    const index = new SearchIndex();
    index.open(USER, amk);
    index.note(msg(1, 'to be deleted'));
    await index.flush();
    expect(databases.has('kw-search')).toBe(true);
    await index.destroy();
    expect(databases.has('kw-search')).toBe(false);
    expect(await index.search('deleted')).toEqual([]);
    // Still switched on: new content is indexed again.
    index.note(msg(2, 'fresh start'));
    expect((await index.search('fresh')).length).toBe(1);
    index.close();
    // The panic wipe and sign-out delete the database without an unlocked account.
    await deleteSearchDatabase();
    expect(databases.has('kw-search')).toBe(false);
  });

  it('caps very long texts and skips rewriting what did not change', async () => {
    const index = new SearchIndex();
    index.open(USER, newSymmetricKey());
    index.note(msg(1, `${'word '.repeat(2000)}needle`));
    expect(await index.search('needle')).toEqual([]);
    expect((await index.search('word'))[0]!.doc.text.length).toBe(MAX_TEXT);
    const before = [...stored().values()][0];
    index.note(msg(1, `${'word '.repeat(2000)}needle`));
    await index.flush();
    expect([...stored().values()][0]).toBe(before);
  });

  it('tells listeners when it changes', async () => {
    const index = new SearchIndex();
    let calls = 0;
    index.subscribe(() => { calls++; });
    index.open(USER, newSymmetricKey());
    index.note(msg(1, 'hello'));
    await index.flush();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(index.getVersion()).toBe(calls);
  });
});
