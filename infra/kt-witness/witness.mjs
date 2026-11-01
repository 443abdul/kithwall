#!/usr/bin/env node
// Public witness for Kithwall's key-transparency log (docs/v2/09-key-transparency.md §5). Run daily by
// .github/workflows/kt-witness.yml; anyone can run it themselves:
//
//   node infra/kt-witness/witness.mjs --origin https://www.kithwall.com --dir <folder with head.json>
//
// It fetches the log's current tree head, and when a head was witnessed before (head.json in --dir) it
// fetches an RFC 9162 consistency proof between the two and verifies it: the old tree must be a prefix of
// the new one. On success it writes the new head to head.json and appends it to heads.jsonl. A log that
// shrank, or whose history was rewritten, makes it exit with code 1 and change nothing, so the failed
// run (and the unchanged branch) is public evidence. Exit code 2: the log couldn't be reached or answered
// nonsense (nothing is written either).
//
// Deliberately self-contained (Node's own crypto, no dependencies) and independent of packages/crypto, so
// it is a second implementation of the verifier; packages/crypto/test/witness.test.mjs checks the two agree.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const NODE = Uint8Array.of(0x01);
const node = (l, r) => sha256(NODE, l, r);
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const HASH = /^[A-Za-z0-9_-]{43}$/;

/** base64url hash → 32 bytes, or null. */
export function decodeHash(s) {
  if (typeof s !== 'string' || !HASH.test(s)) return null;
  const b = new Uint8Array(Buffer.from(s, 'base64url'));
  return b.length === 32 ? b : null;
}

/** A head as returned by GET /api/kt/head, validated; null when malformed. */
export function parseHead(v) {
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.size) || v.size < 0 || !decodeHash(v.root)) return null;
  return { size: v.size, root: v.root, at: typeof v.at === 'string' ? v.at : null };
}

const isPow2 = (n) => { let k = 1; while (k < n) k *= 2; return k === n; };
const odd = (n) => n % 2 === 1;
const half = (n) => Math.floor(n / 2);

/** RFC 9162 §2.1.4.2: is the tree (size1, root1) a prefix of the tree (size2, root2)? */
export function verifyConsistency(size1, size2, proof, root1, root2) {
  if (!Number.isSafeInteger(size1) || !Number.isSafeInteger(size2) || size1 < 0 || size1 > size2) return false;
  if (!(root1 instanceof Uint8Array) || !(root2 instanceof Uint8Array) || !Array.isArray(proof) || proof.length > 64) return false;
  if (!proof.every((p) => p instanceof Uint8Array && p.length === 32)) return false;
  if (size1 === size2) return proof.length === 0 && equal(root1, root2);
  if (size1 === 0) return proof.length === 0 && equal(root1, sha256(new Uint8Array(0)));
  if (proof.length === 0) return false;
  const path = isPow2(size1) ? [root1, ...proof] : [...proof];
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (odd(fn)) { fn = half(fn); sn = half(sn); }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = node(c, fr);
      sr = node(c, sr);
      while (!odd(fn) && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      sr = node(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && equal(fr, root1) && equal(sr, root2);
}

/** Decide what to do with a fresh head given the last witnessed one. Pure; returns the verdict. */
export function judge(prev, fresh, proof) {
  if (!prev) return { ok: true, changed: fresh.size > 0 };
  if (fresh.size < prev.size) return { ok: false, why: `the log shrank from ${prev.size} to ${fresh.size} entries` };
  if (fresh.size === prev.size) {
    return fresh.root === prev.root ? { ok: true, changed: false } : { ok: false, why: `two different roots for ${prev.size} entries` };
  }
  const p = Array.isArray(proof) ? proof.map(decodeHash) : null;
  if (!p || p.some((x) => !x)) return { ok: false, why: 'malformed consistency proof' };
  return verifyConsistency(prev.size, fresh.size, p, decodeHash(prev.root), decodeHash(fresh.root))
    ? { ok: true, changed: true }
    : { ok: false, why: `the tree of ${prev.size} entries is not a prefix of the tree of ${fresh.size} entries` };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'kithwall-kt-witness' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const README = `# Kithwall key-log witness

This branch is written only by the \`kt-witness\` GitHub Actions workflow. Once a day it fetches the
tree head of Kithwall's public key-transparency log (\`/api/kt/head\`), verifies an RFC 9162 consistency
proof from the head it recorded before, and commits the new head here:

- \`head.json\`: the latest witnessed head \`{ size, root, at, witnessedAt, origin }\`
- \`heads.jsonl\`: every witnessed head, one per line

If the log ever shrinks or its history is rewritten, the workflow fails and records nothing, so the last
commit here stays as evidence. Kithwall's apps can compare their own head with \`head.json\`
(Transparency page → Public key log). Design: \`docs/v2/09-key-transparency.md\` on the main branch.
`;

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const origin = (arg('origin') ?? 'https://www.kithwall.com').replace(/\/+$/, '');
  const dir = arg('dir') ?? '.';
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    console.error('--origin must be an https origin');
    return 2;
  }
  const file = join(dir, 'head.json');
  const prev = existsSync(file) ? parseHead(JSON.parse(readFileSync(file, 'utf8'))) : null;
  if (existsSync(file) && !prev) { console.error(`${file} is malformed`); return 2; }

  let fresh;
  let proof = null;
  try {
    fresh = parseHead(await getJson(`${origin}/api/kt/head`));
    if (!fresh) throw new Error('malformed head');
    if (prev && fresh.size > prev.size) proof = (await getJson(`${origin}/api/kt/consistency?from=${prev.size}&to=${fresh.size}`)).proof;
  } catch (e) {
    console.error(`could not read the log: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const v = judge(prev, fresh, proof);
  if (!v.ok) {
    console.error(`INCONSISTENT KEY LOG at ${origin}: ${v.why}`);
    console.error(`previously witnessed: ${JSON.stringify(prev)}`);
    console.error(`now served:           ${JSON.stringify(fresh)}`);
    return 1;
  }
  if (!v.changed) { console.log(`unchanged: ${fresh.size} entries, root ${fresh.root}`); return 0; }
  const rec = { size: fresh.size, root: fresh.root, at: fresh.at, witnessedAt: new Date().toISOString(), origin };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  appendFileSync(join(dir, 'heads.jsonl'), `${JSON.stringify(rec)}\n`);
  if (!existsSync(join(dir, 'README.md'))) writeFileSync(join(dir, 'README.md'), README);
  console.log(`${prev ? `consistent with ${prev.size} entries; ` : 'first head; '}witnessed ${fresh.size} entries, root ${fresh.root}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
