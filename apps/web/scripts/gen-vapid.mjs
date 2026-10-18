#!/usr/bin/env node
// Prints a fresh VAPID key pair (P-256) for Web Push, plus a random dispatch secret.
//   node apps/web/scripts/gen-vapid.mjs
// Put the values in apps/web/.env.local (local) or the Vercel project env (production).
// Never commit them. Rotating the VAPID pair invalidates every existing push subscription:
// browsers re-subscribe the next time the user opens Kithwall with push enabled.
import { createECDH, randomBytes } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = ecdh.getPublicKey().toString('base64url');          // 65-byte uncompressed point
const raw = ecdh.getPrivateKey();
const priv = Buffer.alloc(32);
raw.copy(priv, 32 - raw.length);                                          // left-pad to 32 bytes
const privateKey = priv.toString('base64url');
const dispatchSecret = randomBytes(32).toString('base64url');

console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:security@kithwall.com`);
console.log(`PUSH_DISPATCH_SECRET=${dispatchSecret}`);
