// Run: npx vitest run src/lib/peopleSync.test.ts
// Live profile updates: which cached profiles a sync re-reads, that old pictures are freed, and that the
// People cache shows a connection's new name/photo after a sync (and only re-reads what changed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64u, generateIdentity, sealEnvelope } from '@kithwall/crypto';
import { coalescer, droppedPaths, staleInfos, type InfoStamp } from './peopleSync';

// In-memory stand-in for the two tables People reads.
const db = vi.hoisted(() => ({
  profiles: [] as Record<string, unknown>[],
  profile_info: [] as Record<string, unknown>[],
  selects: [] as { table: string; cols: string; ids: string[] }[],
}));
vi.mock('./supabase', () => ({
  must: <T,>(r: { data: T; error: unknown }) => { if (r.error) throw new Error('db'); return r.data; },
  sb: () => ({
    from: (table: 'profiles' | 'profile_info') => ({
      select: (cols: string) => ({
        eq: async (col: string, id: string) => ({ data: structuredClone(db[table].filter((r) => r[col] === id)), error: null }),
        in: async (col: string, ids: string[]) => {
          db.selects.push({ table, cols, ids });
          const rows = db[table].filter((r) => ids.includes(r[col] as string));
          const pick = cols === '*' ? rows : rows.map((r) => Object.fromEntries(cols.split(',').map((c) => [c, r[c]])));
          return { data: structuredClone(pick), error: null };
        },
      }),
    }),
  }),
}));

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';
const AUD = '00000000-0000-0000-0000-0000000000f1';
const st = (user_id: string, updated_at: string, epoch = 1, audience_id = AUD): InfoStamp => ({ user_id, audience_id, epoch, updated_at });

describe('staleInfos', () => {
  const cached = new Map([[A, st(A, 't1')], [B, st(B, 't1')]]);
  it('re-reads only rows whose stamp changed', () => {
    expect(staleInfos(cached, [A, B], [st(A, 't1'), st(B, 't2')])).toEqual({ changed: [B], gone: [] });
  });
  it('a re-seal to a new epoch counts as a change', () => {
    expect(staleInfos(cached, [A], [st(A, 't1', 2)])).toEqual({ changed: [A], gone: [] });
  });
  it('a row I could not see before is fetched; a row I can no longer see is dropped', () => {
    expect(staleInfos(cached, [A, B, C], [st(A, 't1'), st(C, 't0')])).toEqual({ changed: [C], gone: [B] });
  });
  it('people not asked about are left alone, and nothing cached + nothing fresh is a no-op', () => {
    expect(staleInfos(cached, [C], [])).toEqual({ changed: [], gone: [] });
    expect(staleInfos(cached, [A], [st(A, 't1'), st(B, 't9')])).toEqual({ changed: [], gone: [] });
  });
  it('a row moved to another audience is a change', () => {
    expect(staleInfos(cached, [A], [st(A, 't1', 1, 'other')])).toEqual({ changed: [A], gone: [] });
  });
});

describe('droppedPaths', () => {
  it('lists the paths the new picture no longer uses', () => {
    expect(droppedPaths(['a', 'b', 'c'], ['a', 'x'])).toEqual(['b', 'c']);
    expect(droppedPaths(undefined, ['a'])).toEqual([]);
    expect(droppedPaths(['a'], [])).toEqual(['a']);
  });
});

describe('coalescer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('folds a burst into one run, and a request during a run into exactly one more', async () => {
    let release: () => void = () => undefined;
    const task = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const c = coalescer(task, 100);
    c.request(); c.request(); c.request();
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    c.request(); c.request(); // while running
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('keeps working after a failed run', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const c = coalescer(task, 10);
    c.request(); await vi.advanceTimersByTimeAsync(10);
    c.request(); await vi.advanceTimersByTimeAsync(10);
    expect(task).toHaveBeenCalledTimes(2);
    c.stop();
  });
});

describe('People: a connection changes their photo and name', () => {
  const bob = generateIdentity();
  const key = new Uint8Array(32).fill(7);
  const avatar = (n: string) => ({
    big: { path: `${B}/big-${n}`, key: 'k', mime: 'image/jpeg', bytes: 1, w: 1, h: 1 },
    med: { path: `${B}/med-${n}`, key: 'k', mime: 'image/jpeg', bytes: 1, w: 1, h: 1 },
    thumb: { path: `${B}/thumb-${n}`, key: 'k', mime: 'image/jpeg', bytes: 1, w: 1, h: 1 },
  });
  const infoRow = (name: string, n: string, updated_at: string) => ({
    user_id: B, audience_id: AUD, epoch: 1, updated_at,
    envelope: sealEnvelope({
      header: { v: 1 as const, type: 'profile_info', id: B, author: B, audience: { id: AUD, epoch: 1 } },
      payload: { name, avatar: avatar(n) }, audienceKey: key, signPriv: bob.signPriv,
    }),
  });

  it('shows the new name and picture after a sync, re-reads only what changed, and frees the old picture', async () => {
    const { people } = await import('./people');
    db.profiles = [{ id: B, username: 'bob', discoverable: false, display_name_public: null, sign_pub: b64u.encode(bob.signPub), kx_pub: b64u.encode(bob.kxPub), key_version: 1, status: 'active', suspended_until: null, created_at: '' }];
    db.profile_info = [infoRow('Bob', '1', '2026-10-01T00:00:00Z')];
    people.setKeyLookup((aud, epoch) => (aud === AUD && epoch === 1 ? key : null));
    const released: string[][] = [];
    people.setFileRelease((p) => released.push(p));
    let bumps = 0;
    people.subscribe(() => { bumps++; });

    await people.ensure([B]);
    expect(people.person(B)?.name).toBe('Bob');
    expect(people.person(B)?.info?.avatar?.thumb.path).toBe(`${B}/thumb-1`);

    // Nothing changed: one cheap stamp query, no envelope re-read, no re-render.
    db.selects = []; bumps = 0;
    await people.syncInfos();
    expect(db.selects.map((s) => s.cols)).toEqual(['user_id,audience_id,epoch,updated_at']);
    expect(bumps).toBe(0);

    // Bob saves a new photo and name.
    db.profile_info = [infoRow('Robert', '2', '2026-10-02T00:00:00Z')];
    db.selects = [];
    await people.syncInfos();
    expect(db.selects.map((s) => s.cols)).toEqual(['user_id,audience_id,epoch,updated_at', '*']);
    expect(db.selects[1]!.ids).toEqual([B]);
    expect(bumps).toBeGreaterThan(0);
    const p = people.person(B);
    expect(p?.name).toBe('Robert');
    expect(p?.info?.avatar?.thumb.path).toBe(`${B}/thumb-2`);
    expect(released.flat().sort()).toEqual([`${B}/big-1`, `${B}/med-1`, `${B}/thumb-1`]);

    // The connection ends (RLS hides the row): the cached profile info goes, and so does the picture.
    db.profile_info = [];
    released.length = 0;
    await people.syncInfos();
    expect(people.person(B)?.info).toBeNull();
    expect(people.person(B)?.name).toBe('bob');
    expect(released.flat().sort()).toEqual([`${B}/big-2`, `${B}/med-2`, `${B}/thumb-2`]);
  });

  it('an optimistic local row shows at once and a failed save can restore the previous one', async () => {
    const { people } = await import('./people');
    db.profile_info = [infoRow('Bob', '1', '2026-10-01T00:00:00Z')];
    await people.refreshInfo(B);
    const prev = people.infoRow(B)!;
    people.applyInfoRows([infoRow('Bobby', '3', 'local')]);
    expect(people.person(B)?.name).toBe('Bobby');
    people.applyInfoRows([prev]);
    expect(people.person(B)?.name).toBe('Bob');
  });
});
