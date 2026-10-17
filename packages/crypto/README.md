# @kithwall/crypto

All client-side cryptography for Kithwall (normative design: `docs/03-spec.md` §3).
Runs in browsers and Web Workers: there is no Buffer and no `node:crypto`, and randomness comes from `crypto.getRandomValues`.

- Primitives: XChaCha20-Poly1305 and X25519/Ed25519 (@noble), HKDF-SHA-256 and SHA-2 (@noble/hashes), Argon2id (hash-wasm), BIP-39 (@scure/bip39), Shamir (shamir-secret-sharing).
- Stored or sent binary values are **base64url without padding**. Decoding is strict, so each value has exactly one encoding. In-memory keys are `Uint8Array`.
- Every failure throws `KithwallCryptoError` with a `code`: `bad_password`, `bad_phrase`, `bad_signature`, `decrypt_failed`, `bad_share` or `invalid_input`.
- Signatures are Ed25519 with strict verification (no ZIP-215 leniency). They are computed over `canonicalJson` (sorted keys, no whitespace) of an object that carries a `d` domain string.
- Every AEAD uses a fresh random 24-byte nonce. File chunks are the exception: they use a random 16-byte prefix plus the chunk index under a fresh per-file key.

## Formats

| Thing | Format |
|---|---|
| packed blob (wraps, `encryptBlob`, `wk`) | `b64u(0x01 ‖ nonce24 ‖ ct‖tag)` |
| `Sealed` | `{v:1, eph, n, ct, sig}` |
| `Envelope` | encrypted `{v:1, wk, n, ct, sig}` · comment `{v:1, n, ct, sig}` · public `{v:1, body, sig}` |
| file ciphertext | `0x01 ‖ prefix16 ‖ chunk_0 ‖ …`, each chunk ≤ 64 KiB plaintext + 16-byte tag, at least one chunk |
| recovery share | 33 bytes (32 share bytes ‖ x-coordinate) |

## Derivations

```
salt          = SHA-256("kithwall/v1/salt" ‖ NFKC(lower(trim(email))))[0..16]
stretched     = Argon2id(NFKC(password), salt, m=65536 KiB, t=3, p=1, 32 B)
authKey       = b64u(HKDF(stretched, "kithwall/v1/auth"))
passwordKEK   = HKDF(stretched, "kithwall/v1/kek")
RK            = BIP-39 entropy of the 24-word phrase (32 B)
recoveryKEK   = HKDF(RK,  "kithwall/v1/recovery-kek")
rkCommitment  = b64u(SHA-256("kithwall/v1/rk-commitment" ‖ RK))
identityKey   = HKDF(AMK, "kithwall/v1/identity-key")
vaultKey      = HKDF(AMK, "kithwall/v1/vault")
cacheKey      = HKDF(AMK, "kithwall/v1/cache")
subkey        = HKDF(key, "kithwall/v1/subkey/<label>/<id>")       e.g. comment key = deriveSubkey(CK, "comment", commentId)
seal key      = HKDF(X25519(eph, recipient), salt = eph_pub ‖ recipient_pub, "kithwall/v1/seal")
```

## Domain-separation strings

| Use | String |
|---|---|
| key wraps (AAD) | `kithwall/v1/wrap/amk-password/<userId>`, `…/amk-recovery/<userId>`, `…/identity/<userId>` |
| vault/cache blobs (AAD) | `kithwall/v1/blob/<aad>` |
| sealed box (AAD) | `kithwall/v1/seal/<context>` |
| sealed box signature | `{d:"kithwall/v1/seal-sig", v:1, context, recipient, eph, n, ct}` |
| envelope wk (AAD) | `kithwall/v1/envelope/wk\n` + canonicalJson(header) |
| envelope ct (AAD) | `kithwall/v1/envelope/ct\n` + canonicalJson(header) |
| envelope signature | `{d:"kithwall/v1/envelope-sig", header, wk?, n?, ct?, body?}` |
| file chunk (AAD) | `"kithwall/v1/file\n" ‖ u64be(index) ‖ final(1 B) ‖ fileId` |
| verification phrase | SHA-256(lp("kithwall/v1/verification-phrase", requestId, ephPub)) → 6 × 11 bits |
| safety number | SHA-512(lp("kithwall/v1/safety-number", userId, signPub)), then 5200 iterations |
| proof-of-key | `{d:"kithwall/v1/proof-of-key", nonce}` |
| key change | `{d:"kithwall/v1/key-change", userId, newSignPub, newKxPub, at}` |

Suggested `seal` contexts: `audience-key/<audienceId>/<epoch>/<recipientId>`, `conversation-key/<convId>/<epoch>/<recipientId>`, `recovery-share/<ownerId>/<trusteeId>`, `recovery-release/<requestId>/<trusteeId>`.

## Rules for callers

- `openEnvelope`, `openWithContentKey` and `openSealed` check the signature **before** they decrypt. Hide anything that throws and show "This item couldn't be verified."
- `extractContentKey` checks the signature only when you pass `signPub`. Without it, call it only on an envelope that has already been verified.
- `deriveFromPassword` refuses Argon2 parameters below m=64 MiB, t=3. `{ allowWeakParams: true }` turns that check off and is for tests only.
- `unlockWithPassword`, `unlockWithRecoveryPhrase`, `unlockWithRecoveryKey` and `unlockWithAmk` all check that the decrypted private keys match `bundle.signPub` and `bundle.kxPub`.
- After `rotateRecovery`, replace both `amkByRecovery` and `rkCommitment`, re-split `rk` to the trustees, then wipe `rk`.

Tests: `npx vitest run packages/crypto` from the repo root.
