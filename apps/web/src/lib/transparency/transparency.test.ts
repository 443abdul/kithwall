// Run: npx vitest run src/lib/transparency
// Key-change chains (verified contact warnings), the readable data map staying in step with the
// database map in the migration, and the public report facts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { b64u, generateIdentity, parseSafetyQr, safetyNumber, safetyQrPayload, signKeyChange, type KeyChange } from '@kithwall/crypto';
import { encodeQr } from '../qr';
import { uaSummary, vouchedChain, type KeyChangeRow } from './chain';
import { CATEGORIES, STATIC_MAP, TABLES } from './datamap';
import { TRANSPARENCY_FACTS } from './facts';

const a = generateIdentity();
const b = generateIdentity();
const c = generateIdentity();
const pub = (x: { signPub: Uint8Array }) => b64u.encode(x.signPub);
function step(from: typeof a, to: typeof a, at: string): KeyChangeRow {
  const change: KeyChange = { userId: 'u1', newSignPub: pub(to), newKxPub: b64u.encode(to.kxPub), at };
  return { change, sig: signKeyChange(from.signPriv, change), created_at: at };
}

describe('vouchedChain', () => {
  it('is true when each change was signed by the previous key', () => {
    expect(vouchedChain(pub(a), pub(b), [step(a, b, '2026-10-01T00:00:00Z')])).toBe(true);
    // Rows arrive in any order; they are followed by time.
    expect(vouchedChain(pub(a), pub(c), [step(b, c, '2026-10-02T00:00:00Z'), step(a, b, '2026-10-01T00:00:00Z')])).toBe(true);
  });
  it('is false when a step is missing or not signed by the key before it', () => {
    expect(vouchedChain(pub(a), pub(c), [step(b, c, '2026-10-02T00:00:00Z')])).toBe(false);
    expect(vouchedChain(pub(a), pub(c), [step(c, c, '2026-10-01T00:00:00Z')])).toBe(false);
    expect(vouchedChain(pub(a), pub(b), [])).toBe(false);
    const forged = { ...step(a, b, '2026-10-01T00:00:00Z'), sig: step(c, b, '2026-10-01T00:00:00Z').sig };
    expect(vouchedChain(pub(a), pub(b), [forged])).toBe(false);
    expect(vouchedChain(pub(a), pub(b), [{ change: null as unknown as KeyChange, sig: 'x', created_at: '1' }])).toBe(false);
  });
  it('is trivially true when nothing changed', () => {
    expect(vouchedChain(pub(a), pub(a), [])).toBe(true);
  });
});

describe('safety QR', () => {
  it('fits a medium-ECC QR code and round-trips', () => {
    const n = safetyNumber({ userId: 'u-a', signPub: a.signPub }, { userId: 'u-b', signPub: b.signPub });
    const qr = encodeQr(safetyQrPayload(n), 'M');
    expect(qr.version).toBeLessThanOrEqual(5);
    expect(parseSafetyQr(safetyQrPayload(n))).toBe(n);
  });
});

describe('uaSummary', () => {
  it('names the browser and system without versions', () => {
    expect(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36')).toBe('Chrome · Windows');
    expect(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(uaSummary('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome · Android');
    expect(uaSummary('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox · Linux');
    expect(uaSummary(null)).toBeNull();
    expect(uaSummary('curl/8')).toBeNull();
  });
});

describe('data map labels match the database map', () => {
  const dir = join(__dirname, '..', '..', '..', '..', '..', 'supabase', 'migrations');
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const mapped = new Map<string, string>();
  for (const m of sql.matchAll(/\('((?:public|kw)\.[a-z_]+)', '(account|content|social|messages|activity|housekeeping|legacy|system)'/g)) mapped.set(m[1]!, m[2]!);

  it('finds the map in the migrations', () => {
    expect(mapped.size).toBeGreaterThan(40);
  });
  it('labels only tables the database map knows', () => {
    for (const t of Object.keys(TABLES)) expect(mapped.has(t), t).toBe(true);
  });
  it('puts each table of the static map in its database category', () => {
    for (const g of STATIC_MAP) for (const t of g.tables) {
      expect(mapped.get(t), t).toBe(g.category);
      expect(TABLES[t], `${t} needs a label`).toBeDefined();
    }
  });
  it('has a section for every category that holds personal rows', () => {
    const cats = new Set([...mapped.values()].filter((x) => x !== 'system'));
    expect(new Set(CATEGORIES.map((x) => x.id))).toEqual(cats);
  });
});

describe('transparency facts', () => {
  it('are dated and consistent', () => {
    const f = TRANSPARENCY_FACTS;
    expect(f.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.since <= f.asOf).toBe(true);
    expect(f.requests.produced).toBeLessThanOrEqual(f.requests.userData);
    expect(Number.isNaN(new Date(f.asOf).getTime())).toBe(false);
  });
});
