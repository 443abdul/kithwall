#!/usr/bin/env node
// Signed mirror list tool (docs/v2/08-censorship.md §2). Node 22+, no dependencies.
//
//   node scripts/mirrors.mjs keygen  --out <file outside the repository>
//   node scripts/mirrors.mjs example > mirrors.payload.json          (edit it)
//   node scripts/mirrors.mjs sign    --key <key file> --in mirrors.payload.json [--out mirrors.signed.json]
//   node scripts/mirrors.mjs verify  --pub <base64url public key> --in mirrors.signed.json
//
// The private key signs the list the app trusts. Whoever holds it can point every Kithwall client at any
// server (they still can't read anyone's messages: content is end-to-end encrypted, but they could serve
// a modified app). Keep it OFFLINE (a password manager or an encrypted USB stick, plus a paper backup),
// never in the repository, never in Vercel or CI. Only the public key goes into
// NEXT_PUBLIC_MIRROR_LIST_PUBKEY.
//
// Signature: Ed25519 over UTF-8("kithwall/mirror-list/v1\n" + body), the same as packages/crypto signed.ts.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXT = 'kithwall/mirror-list/v1';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(`mirrors: ${msg}`); process.exit(1); };
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function privFromFile(path) {
  const k = JSON.parse(readFileSync(path, 'utf8'));
  if (k.kind !== 'kithwall-mirror-list-key' || typeof k.priv !== 'string') die('not a mirror-list key file');
  const seed = Buffer.from(k.priv, 'base64url');
  if (seed.length !== 32) die('bad key');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}
const rawPub = (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
const pubFromB64u = (s) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(s, 'base64url')]), format: 'der', type: 'spki' });

if (cmd === 'keygen') {
  const out = opt('out');
  if (!out) die('--out <file> is required (somewhere OUTSIDE this repository, e.g. an encrypted USB stick)');
  const abs = resolve(out);
  if (abs === REPO || abs.startsWith(REPO + sep)) die(`refusing to write the private key inside the repository (${REPO})`);
  if (existsSync(abs)) die(`${abs} exists; not overwriting a key`);
  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);
  const pub = b64u(rawPub(privateKey));
  writeFileSync(abs, JSON.stringify({ kind: 'kithwall-mirror-list-key', created: new Date().toISOString(), pub, priv: b64u(seed) }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Private key written to ${abs} (keep it offline; back it up on paper; never commit it).`);
  console.log('\nPublic key: set this in Vercel (Production + Preview) and rebuild:');
  console.log(`  NEXT_PUBLIC_MIRROR_LIST_PUBKEY=${pub}`);
  console.log('\nRotating the key later means shipping a new app build with the new public key; old clients keep');
  console.log('trusting the old key until they update, so do not lose it.');
} else if (cmd === 'example') {
  const now = new Date();
  const exp = new Date(now.getTime() + 90 * 24 * 3600_000);
  console.log(JSON.stringify({
    format: 'kithwall-mirrors',
    version: 1,
    issued: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    expires: exp.toISOString().replace(/\.\d+Z$/, 'Z'),
    mirrors: [
      { origin: 'https://www.kithwall.com', api: 'https://www.kithwall.com/sb', kind: 'primary', label: 'Kithwall' },
      { origin: 'https://mirror-one.example', api: 'https://mirror-one.example/sb', realtime: 'wss://mirror-one.example/sb', kind: 'mirror' },
    ],
    apk: [{ url: 'https://github.com/443abdul/kithwall/releases/latest' }],
    apkCert: '',
    note: '',
  }, null, 2));
} else if (cmd === 'sign') {
  const keyPath = opt('key'); const inPath = opt('in');
  if (!keyPath || !inPath) die('usage: sign --key <key file> --in <payload.json> [--out <signed.json>]');
  const payload = JSON.parse(readFileSync(inPath, 'utf8'));
  if (payload.format !== 'kithwall-mirrors') die('payload.format must be "kithwall-mirrors"');
  if (!Number.isSafeInteger(payload.version) || payload.version < 1) die('payload.version must be a positive integer (increase it every time)');
  if (Number.isNaN(Date.parse(payload.issued)) || Number.isNaN(Date.parse(payload.expires))) die('issued / expires must be ISO dates');
  if (Date.parse(payload.expires) <= Date.now()) die('expires is in the past');
  for (const m of payload.mirrors ?? []) {
    const u = new URL(m.origin);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname.endsWith('.onion'))) die(`mirror ${m.origin}: https only (or http .onion)`);
  }
  if (!payload.apkCert) delete payload.apkCert;
  if (!payload.note) delete payload.note;
  const body = JSON.stringify(payload);
  const key = privFromFile(keyPath);
  const sig = b64u(sign(null, Buffer.from(`${CONTEXT}\n${body}`, 'utf8'), key));
  const signed = JSON.stringify({ 'kithwall-mirrors': 1, body, sig });
  const token = 'kwm1.' + b64u(Buffer.from(signed, 'utf8'));
  if (opt('out')) writeFileSync(opt('out'), signed + '\n');
  else console.log(signed);
  console.error(`\nSigned version ${payload.version} (${payload.mirrors?.length ?? 0} mirrors) with public key ${b64u(rawPub(key))}.`);
  console.error('Publish the signed JSON: KITHWALL_MIRROR_LIST env on every deployment (/api/net/mirrors), a GitHub');
  console.error('raw file, IPFS, … (list those URLs in NEXT_PUBLIC_MIRROR_LIST_URLS).');
  console.error(`Share token for QR / messages (${token.length} characters):\n${token}`);
} else if (cmd === 'verify') {
  const pub = opt('pub'); const inPath = opt('in');
  if (!pub || !inPath) die('usage: verify --pub <base64url> --in <signed.json>');
  const s = JSON.parse(readFileSync(inPath, 'utf8'));
  const ok = verify(null, Buffer.from(`${CONTEXT}\n${s.body}`, 'utf8'), pubFromB64u(pub), Buffer.from(s.sig, 'base64url'));
  if (!ok) die('signature does NOT verify');
  const p = JSON.parse(s.body);
  console.log(`OK: version ${p.version}, expires ${p.expires}${Date.parse(p.expires) <= Date.now() ? ' (EXPIRED)' : ''}, ${p.mirrors.length} mirrors`);
} else {
  console.log('usage: node scripts/mirrors.mjs keygen|example|sign|verify  (see the top of this file)');
  process.exit(cmd ? 1 : 0);
}
