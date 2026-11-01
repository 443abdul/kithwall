# 09 — Key transparency: a public, append-only log of identity keys

Status: implemented (roadmap 2026-11, Batch 2 item 7; research brief D6). Migration
`supabase/migrations/20261102000500_key_transparency.sql`; daily public witness `.github/workflows/kt-witness.yml`
(needs enabling, §8).

Everything Kithwall encrypts is sealed to people's **identity keys** (`profiles.sign_pub` / `kx_pub`). Whoever
controls the server could hand Alice a key of its own instead of Bob's and read what Alice sends "to Bob".
Before this change three things already stood in the way:

- **Pins** (security review K2, `lib/keys/pins.ts`): the first key a device sees for a contact is pinned; any
  later difference is a "safety number changed" warning, and new keys are not shared with a changed key
  unless Bob's *old* key signed the change (`key_changes`, `vouchedFrom`).
- **Safety numbers** (`/u/<handle>/verify`): comparing them in person proves there is nobody in the middle.
- **Signed rotations only** (`public.apply_identity_key_change`): the database refuses any other key change,
  even from the service role.

What was missing: nothing stopped the server from showing Alice a fake Bob **the first time** she met him
(trust on first use), or from showing different people different keys, without leaving any trace. The key
log makes every key the server ever hands out a permanent public record, and lets every device check that
the record is the same for everyone and is never rewritten.

---

## 1. What the log is

An RFC 9162 (Certificate Transparency v2) Merkle tree over SHA-256, append-only, one leaf per **identity-key
publication**: every sign-up and every signed rotation (and, at migration time, every existing account's
current key). Tree hashing is the standard one, implemented once in `packages/crypto/src/merkle.ts`:

```
MTH({})    = SHA-256()
leaf hash  = SHA-256(0x00 ‖ leaf data)
node hash  = SHA-256(0x01 ‖ left ‖ right)          k = largest power of two < n
```

with RFC 9162 inclusion proofs ("this leaf is at index i of the tree of size n with root r") and consistency
proofs ("the tree of size m is a prefix of the tree of size n"). Both are verified on the device. Test vectors:
the RFC 6962 reference data (`packages/crypto/test/merkle.test.ts`), shared vectors for the leaf format
(`test/kt.test.ts`, checked against the SQL in `supabase/tests/key_transparency.test.sql`), an end-to-end
test that verifies the database's own proofs with the device code (`apps/web/src/lib/kt/kt.e2e.test.ts`), and
the independent witness verifier checked against the library (`test/witness.test.mjs`).

A **tree head** is `(size, root, time of the last entry)`. The database stores one after every append.

### 1.1 Leaves hide who they are about

A public list of every account's key would be a public directory of Kithwall's users, kept forever. So a leaf
holds only a salted commitment (`packages/crypto/src/kt.ts`):

```
commitment = SHA-256(lp("kithwall/v1/kt-commit", userId, signPub, kxPub, u64be(keyVersion), salt))
leaf data  = lp("kithwall/v1/kt-leaf", commitment)
lp(x)      = 4-byte big-endian length ‖ x;   salt = 32 random bytes chosen when the leaf is appended
```

The **opening** (salt, key version, leaf index) is stored next to the leaf in `kw.kt_openings` and handed out
only to signed-in people allowed to see that profile (`kw.can_see_profile`, the same rule as the profile
row: connections, people who share a circle, event or chat, mutual connections, the opt-in directory, …).
Everyone else, including anyone reading the public log, sees 32 random-looking bytes per entry.

**Account deletion** deletes the openings (foreign key, `on delete cascade`). The leaves stay, as an
append-only log requires, but without the salt nothing links them to anyone, and nothing in them can be
brute-forced: user ids are random UUIDs, keys are random, and the salt is 256 random bits.

### 1.2 Privacy trade-offs (what the log does reveal)

- **The number of key publications and their times.** The public head reveals how many entries exist and
  when the last one was added, so roughly how many accounts were created or rotated keys, and when. Kithwall
  doesn't consider its sign-up rate secret (it is announced in the transparency report anyway), but an
  observer polling the head every few seconds learns the timing of sign-ups. Batching heads (one per hour)
  would blur that, at the cost of new keys being unverifiable for up to an hour; we chose a head per entry
  for now (§9).
- **People who may see your profile learn your leaf index**, so the approximate date you joined or last
  replaced your key. Your connections can already see that you have an account and when your safety number
  changed.
- **The server knows every opening.** The log protects against the server *lying about keys*, not against
  the server knowing who has an account; it always knew that.
- **Who looks up whom** is visible to the server (it already serves the profile). The lookup is a `POST`
  with the ids in the body so the pair never appears in request logs.

---

## 2. Storage and write rules

All tables are in the private `kw` schema (not exposed through the API) and listed in the data map:

| Table | Holds |
|---|---|
| `kw.kt_leaves (idx, commitment, created_at)` | one row per publication |
| `kw.kt_nodes (level, idx, hash)` | every complete subtree hash (level 0 = leaf hashes): a root or proof needs O(log n) lookups |
| `kw.kt_heads (size, root, created_at)` | the head after every append |
| `kw.kt_openings (leaf_idx, user_id, key_version, sign_pub, kx_pub, salt)` | the opening, deleted with the account |

- The only writer is `kw.kt_publish()`, called by AFTER triggers on `public.profiles`: insert (sign-up) and
  any change of `sign_pub` / `kx_pub` (which only `apply_identity_key_change` can make). The leaf, its nodes
  and the new head are written in the same transaction as the key itself, so a key can't exist without its
  leaf. Appends are serialised by a transaction-level advisory lock.
- No role has INSERT/UPDATE/DELETE/TRUNCATE privileges on these tables (`revoke all … from anon,
  authenticated, service_role`). Triggers refuse UPDATE, DELETE and TRUNCATE of leaves, nodes and heads for
  everyone, the table owner included, and refuse leaves and heads that don't extend the log by exactly one.
  Openings can't be edited, only deleted with their account.
- A database superuser can still disable triggers. That is exactly what the rest of this design is for: a
  rewritten log no longer matches the heads devices and the witness already hold (§4, §5).

## 3. API (route handlers, `apps/web/src/app/api/kt/`)

| Endpoint | Who | Returns |
|---|---|---|
| `GET /api/kt/head[?size=N]` | anyone (CORS *) | `{ size, root, at }`: the latest head (cached 5 s) or the head at size N (immutable) |
| `GET /api/kt/consistency?from=A&to=B` | anyone (CORS *) | `{ from, to, proof }`, RFC 9162 consistency proof, immutable |
| `POST /api/kt/inclusion` (Bearer) | signed-in users | for up to 50 `{ user, signPub, kxPub }`: `ok` with `{ index, version, salt, proof }` at the requested (or latest) head, `missing` (no publication of exactly these keys for this person), `later` (logged after that head) or `hidden` (you may not see this profile; nothing else is revealed) |

The inclusion lookup runs **as the caller** (`public.kt_inclusion`, SECURITY DEFINER, `auth.uid()`), checks
`kw.can_see_profile` per person before anything else, honours the MFA rule and is rate limited (600
requests per hour per account). Hashes are base64url without padding.

## 4. What devices do (`apps/web/src/lib/kt/`)

**Head.** Each device stores the last head it verified in `localStorage` (`kw.kt.head`), deliberately per
device and outside the vault so a server that rolls back the vault can't roll it back too. Every head it
fetches must extend it:

- same size → same root, otherwise the log **forked**;
- larger → a consistency proof from the stored head must verify, otherwise **forked**;
- smaller (a cached response) → it must be provably a prefix of the stored head; if the server can't even
  produce the size the device already saw, the log **shrank**.

A fork or shrink stores an alarm (`kw.kt.alarm`, with both heads as evidence) and the device **fails closed**:
a warning on every signed-in screen (account notices, cannot be dismissed), on the verify screen and on the
Transparency page; no new keys are shared with anyone whose current key it hadn't already confirmed; no
key is shown as "checked". The person can start over only from the Transparency page, after reading why.
The head is verified once per session and whenever a key is checked.

**Keys.** A contact's current keys are checked whenever this account first sees them: first sight, a key
change (both through `resolveSigners` / `sealGate` in `lib/keys/pins.ts`), and every time the safety-number
screen opens (forced re-check). The device recomputes the leaf from the keys **it** is about to use, the
user id and the server's salt, and verifies the audit path against a head it verified. Results are kept per
key in the encrypted vault (namespace `keylog`), so each key is checked once per account:

- `ok`: logged. The verify screen shows **"Key log checked"** with the entry number.
- `missing` / `bad` (not in the log, or a proof that doesn't verify): the existing safety-number warning
  (`KeyChangeBanner`, on the profile, in chats and on the verify screen) says the key log doesn't confirm the
  key, and **new keys are not shared with it** (`sealGate`) until the person compares safety numbers and
  accepts it. Accepting a key change accepts this too.
- `hidden` (someone you aren't connected to, found by exact @handle), `unavailable` (offline, rate limited):
  shown as such, nothing is held back, checked again later (at most every 10 minutes per key).

**Witness (optional).** On the Transparency page, "Compare with the public witness" fetches the latest head
the witness committed (`raw.githubusercontent.com/<repo>/kt-heads/head.json`) and requires it to be consistent
with the device's own head (a mismatch raises the same alarm). It is a request to GitHub, so it only happens
when the person presses the button; `raw.githubusercontent.com` is in `connect-src` for that reason only
(`lib/net/csp.ts witnessConnectSource`, derived from the source repository URL; forks hosted elsewhere get
no witness and no CSP entry).

## 5. The public witness

`.github/workflows/kt-witness.yml` runs daily (04:17 UTC, and on demand). It fetches
`https://www.kithwall.com/api/kt/head`, and if it witnessed a head before, verifies the consistency proof from
that head with `infra/kt-witness/witness.mjs` (a second, dependency-free implementation of the RFC 9162
check). Then it commits `head.json` and appends to `heads.jsonl` on the `kt-heads` branch. If the log shrank or
its history changed, the job fails and commits nothing. It uses only the job's own token, with
`contents: write` in that one job, pinned action SHAs, and never stores the token in `.git/config`.

Anyone can run the same script against the live site or keep their own copy of `kt-heads`; more independent
witnesses make split views (§6) harder to keep up.

## 6. Threat model: what a malicious server can still do

The attacker is whoever controls the server or database (the operator, a hacker, someone with a court
order). They can serve any API response they like and edit the database as superuser.

**Now prevented or exposed**

- *Swapping a key silently for everyone.* The fake key must be in the log, where Bob can see that a key he
  never published was logged for him (§9: today only by comparing safety numbers or checking the entry), and
  where it stays forever as evidence. A key that isn't in the log (`missing`) raises the safety-number
  warning and gets no new keys until the person accepts it.
- *Logging a fake key and later erasing it.* Any device that saw a head after the fake entry, and the
  witness, hold a root that no longer matches: consistency fails, the alarm goes off, and the failed witness
  run is public.
- *Rolling back or rewriting history* (to hide an entry, or to replace one). Same as above.
- *Using the log to enumerate users.* Leaves are salted commitments; openings require profile visibility.

**Still possible**

- **Split views.** The server can keep two consistent but different logs and show one to Alice and another to
  everyone else (including the witness). Alice's device then sees a log in which a fake Bob is present while
  the rest of the world sees none. Nothing on Alice's device alone can detect this. What catches it:
  - *the witness*, as soon as Alice compares her head with the witnessed one (Transparency page) after the
    witness has recorded a head beyond the fork point: the two can't be consistent;
  - *gossip*: comparing heads with anyone else (two devices, two people), the same way;
  - *safety numbers*, which detect the fake key itself whatever the log says.
  A server that wants to sustain a split view must keep it up forever for Alice, across all her devices,
  without her ever comparing with the witness or a friend. Automatic gossip between contacts (sealed heads
  inside messages) would close most of this gap and is the next step (§9).
- **A fake key at first contact that is logged honestly.** If the server creates a fake Bob key, logs it and
  shows it to everyone, the log can't tell it is fake; only Bob can, by noticing a log entry he didn't make.
  Without per-user lookup keys (§9) Bob's device can't find such entries on its own; comparing safety
  numbers still catches it, and the entry is permanent evidence once found.
- **Withholding.** The server can refuse to answer, or answer `hidden`/`unavailable`. Devices then share keys
  as they did before this log existed (pins and safety numbers still apply) and keep retrying; withholding
  can't make a device accept a key the log contradicts.
- **Metadata.** The server sees who looks up whom (as it sees who views whose profile) and the head reveals
  the timing of key publications (§1.2).
- **Compromised client code.** A server that serves malicious JavaScript can switch all checks off. Code
  integrity (published hashes, the signed Android app) is a separate item (roadmap Batch 2, item 8).

## 7. Files

- `packages/crypto/src/merkle.ts`, `src/kt.ts` and their tests (`test/merkle.test.ts`, `test/kt.test.ts`,
  `test/witness.test.mjs`)
- `supabase/migrations/20261102000500_key_transparency.sql`, `supabase/tests/key_transparency.test.sql`
- `apps/web/src/app/api/kt/{head,consistency,inclusion}/route.ts`, `apps/web/src/lib/kt/{core,client,server,witness}.ts`
  (+ `core.test.ts`, `kt.e2e.test.ts`)
- UI: `components/verify/KeyChangeBanner.tsx` (warnings), `components/verify/KeyLogState.tsx` ("Key log
  checked"), `components/shell/AccountNotices.tsx` (fork alarm), `components/transparency/KeyLogSection.tsx`
- `lib/keys/pins.ts` (checks on first sight and change; `sealGate` refuses keys the log doesn't vouch for)
- `.github/workflows/kt-witness.yml`, `infra/kt-witness/witness.mjs`

## 8. Production steps

1. Apply the migration (`supabase db push`, or the migration through the dashboard). It backfills one leaf
   per existing account (one head per leaf; a few seconds for thousands of accounts) under a lock on
   `profiles`, so sign-ups wait for it to finish.
2. Deploy the web app (no new environment variables or secrets).
3. Enable the witness: Actions → "Key log witness" → enable (scheduled workflows run from the default
   branch, so merge first), then "Run workflow" once to create the `kt-heads` branch. Optionally protect
   `kt-heads` so only GitHub Actions can push to it, and never force-push it.
4. Forks: set `NEXT_PUBLIC_SOURCE_REPO` to your GitHub repository and the witness origin (`KT_ORIGIN` in the
   workflow) to your site.

## 9. Not done yet

- **Self-monitoring with private lookup keys.** CONIKS / WhatsApp's key directory index entries by a VRF of
  the user id, so a user's own device can find every entry about it and spot a fake one. That needs a server
  signing/VRF key, which this design avoids on purpose (no new secrets). Devices do check their own current
  key is logged (Transparency page).
- **Automatic gossip** of heads between contacts (inside sealed messages), and checking the witness
  automatically (it would mean a background request to GitHub, which we don't make without asking).
- **Batched heads** to blur sign-up timing (§1.2).
- **A public leaves endpoint** for full audits (download every commitment and recompute the tree); heads
  and consistency proofs are enough for witnesses.
