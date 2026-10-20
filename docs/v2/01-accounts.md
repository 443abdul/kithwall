# Kithwall 2: accounts and keys

Status: implemented (phase 1) · 2026-10-21 · see also `00-brief.md` §3 and §5, and `../03-spec.md` §3

Kithwall 2 accounts are **passkey-first**. There is no email and no password at sign-up. The account's
encryption keys are created on the device and wrapped with a secret that only the passkey can produce
(the WebAuthn **PRF** extension). Devices without passkey PRF support fall back to a **passphrase**,
which works like the v1 password and still needs no email. v1 accounts keep their email, password and
keys, and can add a passkey.

## 1. Key hierarchy (what changed from v1)

Everything below the Account Master Key (AMK) is unchanged from `03-spec.md` §3.1. Only the ways the AMK
is wrapped change.

```
 passkey ──PRF(credential, PRF_APP_SALT)──► prfOutput (32 B, never leaves the device)
                                               │ HKDF(salt = credSalt, "kithwall/v1/prf-wrap")
                                               ▼
                                        wrapKey ──wraps──┐   one wrap per passkey (passkey_wraps)
 passphrase/password ──Argon2id──► passwordKEK ──wraps───┤   bundle.amkByPassword (optional now)
 recovery phrase (24 words) ──HKDF──► recoveryKEK ─wraps─┤   bundle.amkByRecovery (always)
                                                         ▼
                                                        AMK ──► identity keys, vault, cache, …
```

| Value | Definition |
|---|---|
| `PRF_APP_SALT` | `SHA-256("kithwall/v1/prf-app-salt")`, the PRF `eval.first` input for every passkey. |
| `credSalt` | 32 random bytes per passkey, stored next to its wrap (`passkey_wraps.prf_salt`). |
| `wrapKey` | `HKDF-SHA-256(prfOutput, salt = credSalt, info "kithwall/v1/prf-wrap")` |
| `amk_wrap` | `b64u(0x01 ‖ nonce24 ‖ XChaCha20-Poly1305(wrapKey, AMK, aad))`, with aad = `"kithwall/v1/wrap/amk-passkey/<userId>/<credentialId>"` |

The PRF input is one fixed constant because sign-in is **discoverable**: there is no username, so there is
no allow-list, and per-credential `evalByCredential` is not possible. Each passkey still gets a separate
wrapping key, because PRF outputs differ per credential and `credSalt` is random per credential.

The key bundle format stays `v: 1`. `amkByPassword` is now **optional**: it is absent for passkey-only
accounts. `createKeyBundle(userId, null)` makes such a bundle, and `unlockWithPassword` returns
`bad_password` for it. The helpers are in `packages/crypto/src/passkey.ts`: `PRF_APP_SALT`, `newPrfSalt`,
`prfWrapKey`, `wrapAmkWithPrf`, `unwrapAmkWithPrf` and `unlockWithPrf`.

## 2. Supabase auth without email or password

Supabase Auth needs a user and an email, so each passkey or passphrase account gets a **synthetic,
non-routable address**:

```
u<user id without dashes>@id.kithwall.invalid
```

`.invalid` is reserved by RFC 2606 and can never receive mail. The address is never shown and never mailed.

- **Passkey accounts** have no usable password. After the server verifies a WebAuthn registration or
  assertion, it mints a session with `auth.admin.generateLink({ type: 'magiclink', email })`. No email is
  sent: the link is not used. Only `properties.hashed_token` is returned to the browser, which redeems it
  once with `verifyOtp({ token_hash, type: 'magiclink' })`. The token is single use and expires with the
  auth OTP expiry.
- **Passphrase accounts** use the synthetic address as the Argon2id salt and as the Supabase sign-in
  identifier. The Supabase password is the device-derived `authKey`, exactly as in v1.
- **v1 accounts** keep their real email and password. Adding a passkey does not change either.

Admin user creation does **not** run the `before-user-created` hook, so the passkey routes do the hook's
work themselves: they check `signups_enabled` and verify and spend the ALTCHA proof of work in the same
`altcha_spent` table.

## 3. Flows

All routes live under `/api/auth/passkey/`. The browser side is `lib/auth/account-impl.ts`, which
implements the `AccountApi` contract in `lib/auth/account.ts`, together with `lib/auth/passkey-client.ts`.
The server side is `lib/auth/passkey-server.ts`. Wire types are in `lib/auth/passkey-shared.ts`.

### Sign-up with a passkey (`createAccount`)
1. `POST register/options {handle, altcha, mode:'passkey'}`. The server checks the sign-up switch, the
   per-client rate limit, the ALTCHA proof (then spends it), the handle's format, reserved names and
   availability. It allocates the future **user id** and a random 32-byte WebAuthn `user.id`, stores a
   challenge (`intent register`, 5 min, single use), and returns WebAuthn creation options.
2. The browser calls `navigator.credentials.create()` with `prf: {eval: {first: PRF_APP_SALT}}`,
   `residentKey: required` and `userVerification: required`. It sets the person's display name in the
   options locally; the server only saw the handle. Some authenticators return PRF only from `get()`; in
   that case the browser makes one immediate local assertion on the new credential (a second prompt).
   With no PRF at all, it throws `prf_unsupported` and the UI offers the passphrase path. The passkey
   then stays on the device but is never registered with the server.
3. On the device: `createKeyBundle(userId, null)`, then `wrapAmkWithPrf(userId, credentialId, AMK,
   prfOutput, newPrfSalt())`. The PRF result is **deleted from `clientExtensionResults`** before the
   response is sent. The server also refuses any response that still carries one.
4. `POST register/verify {challengeId, bundle, passkey:{response, label, prfSalt, amkWrap}}`. The server
   consumes the challenge and verifies the attestation (origin, rpID, UV). It creates the auth user with
   the allocated id and synthetic address, then calls `create_passkey_account()`. That function writes the
   key bundle, the profile (public keys taken from the bundle), the WebAuthn user handle, the credential and
   its wrap, all in **one transaction**. If any step fails, the auth user is deleted. The server returns the
   one-time `tokenHash`.
5. The browser redeems the token, and the session becomes `ready`. It then saves the encrypted display name
   (`profile_info`, sealed to the friends audience) and redeems an invite code, if there is one. The
   recovery phrase made with the keys is **not** shown now. The UI nudges later with
   `newRecoveryPhrase()` and then `confirmRecoverySaved()`.

### Sign-up with a passphrase (fallback)
`register/options {mode:'passphrase'}` returns `{userId, email(synthetic)}`. The device checks the
passphrase strength (zxcvbn ≥ 3, at least 10 characters). It then derives `authKey` and `passwordKEK`
with Argon2id from (synthetic email, passphrase) and runs `createKeyBundle(userId, passwordKEK)`.
`register/verify {bundle, authKey}` creates the user with `password = authKey`. The browser then signs in
with `signInWithPassword`.

### Sign-in with a passkey (`signInWithPasskey`)
1. `POST login/options` returns a challenge with **no allowCredentials** (discoverable credential).
2. `get()` with the PRF extension; the PRF result is stripped from the response before it is sent.
3. `POST login/verify {challengeId, response}`. The server finds the credential, verifies the assertion
   (UV required, counter), records its use, and returns `{userId, tokenHash, credentialId, wrap}`.
4. The browser redeems the token, loads its key bundle and calls `unlockWithPrf`. The identity keys are
   checked against the bundle's public keys, and the session becomes `ready`.
   - If the account has a **TOTP factor**, the session is `aal1` and RLS hides the bundle. The unwrapped
     AMK is held in memory (`holdPendingAmk`) and the call throws `mfa_required`. The UI then calls
     `finishMfaLogin(code)` from `lib/auth/login.ts`. Its `initSession()` picks up the pending AMK once
     the bundle is readable.
   - Unknown passkey: `no_account_for_passkey`. A passkey without PRF on this device: signed in but
     `locked`, and the call throws `prf_unsupported`.

### Unlocking a locked session (`unlockWithPasskey`)
After a reload on a device that isn't remembered, the session is `locked`. The browser reads the owner's
credential ids and wraps through RLS, runs a **local** assertion with PRF against those credentials, and
unwraps. Nothing is sent to the server, and no server verification is needed, because only the passkey
can produce the PRF output. `unlockOptions()` reports whether the account has passkeys and a password.

### Sign-in with a passphrase (`signInWithPassphrase(handle, passphrase)`)
`POST passphrase/lookup {handle}` returns the account's synthetic address. Then the v1 login path runs:
Argon2id, `signInWithPassword(authKey)` and unlock. For handles that are not passphrase accounts (unknown,
passkey or v1), the route returns a deterministic **decoy** address of the same shape. The response
therefore doesn't reveal which kind of account a handle has, and the sign-in simply fails with
`wrong_passphrase`.

### v1 migration (`signInLegacy` → `addPasskey`)
`signInLegacy(email, password)` runs the v1 `logIn()`. It returns `'mfa'` for TOTP accounts, and the UI
then uses `finishMfaLogin`. `addPasskey()` calls `add/options` with the Bearer token; MFA accounts need
`aal2`. It creates a passkey with PRF, wraps the **existing** AMK, and sends `add/verify`. The email,
password and key bundle are untouched. Later sign-ins can use the passkey or the old password.

### Managing passkeys and recovery
- `listPasskeys()`: owner-only RLS read (`id, label, created_at, last_used_at`).
- `removePasskey(id)`: RPC `remove_passkey`. It refuses (`last_unlock_method`) to remove the last
  passkey unless the account can still be unlocked another way: a password or passphrase wrap in the
  bundle, a recovery phrase confirmed as saved (`account_security.recovery_saved_at`), or trusted-friend
  shares. `newRecoveryPhrase()` clears the "saved" flag before rotating, so the flag never vouches for a
  phrase that no longer works. `confirmRecoverySaved()` sets it again.
- `accountStatus()`: recovery saved, verified notice email, passkey count, and whether a passphrase exists.

### Notice email (`setNoticeEmail`)
This is optional and is **not** a sign-in identifier. `POST notice-email {email}` stores a SHA-256 hash of
a random link token with the address (`notice_email_verifications`, 24 h, at most 5 per day). It then
mails a content-free link. The link's GET only shows a "Confirm" button, so mail scanners that pre-fetch
links don't confirm anything. The POST copies the address to `account_security.notice_email` with
`notice_email_verified_at`. `null` clears the address and any pending links. Notices for deletion and
recovery (`noticeAddress()`) go to the verified notice address, or else to the auth email if it is a real
one. They are never sent to a synthetic address.

## 4. Database (`supabase/migrations/20261021000100_passkeys.sql`)

| Table | Who can read | Who writes | Contents |
|---|---|---|---|
| `passkeys` | owner (RLS, MFA policy) | server RPCs; owner via `remove_passkey` | credential id, COSE public key, signature counter, transports, backed-up flag, label, created/last used |
| `passkey_wraps` | owner (RLS, MFA policy) | server RPCs | per-credential `prf_salt` and `amk_wrap` |
| `passkey_users` | server only | server | random WebAuthn `user.id` per account |
| `webauthn_challenges` | server only | server | challenge, intent, bound user / future user id / handle / WebAuthn user id, IP tag, expiry, used_at |
| `account_security` | owner (RLS, MFA policy) | RPC `mark_recovery_saved`; server | recovery_saved_at, verified notice email |
| `notice_email_verifications` | server only | server | token hash, address, expiry |

Server-only RPCs, executable by `service_role` only: `create_passkey_account`, `add_passkey`,
`passkey_used` (the counter must increase unless it stays 0), `consume_webauthn_challenge` (atomic single
use, intent-bound, unexpired) and `webauthn_recent_challenges` (rate limits). Owner RPCs:
`remove_passkey` and `mark_recovery_saved(p_saved)`. An hourly `pg_cron` job removes challenges more than
an hour after they expire, and verification links a day after they expire. The migration ends with the
same "every public table has RLS" assertion as `20261019000001_integration.sql`. Deleting the auth user
cascades everything; the wraps are gone, so the data is crypto-shredded.

## 5. Threat model notes

**What the server learns** (on top of v1):
- For each passkey: the **credential id**, its **public key**, its **signature counter**, its transports,
  whether it is backed up (synced), a coarse label made on the device ("Chrome on Android"), and when it
  was created and last used.
- The **synthetic email** (derived from the user id; it carries no personal information) and the auth
  timestamps Supabase keeps for every user.
- The WebAuthn `user.id`, which is random and not the account id. Authenticators store it.
- For about an hour after each ceremony: a **daily-rotating keyed hash of the client IP**, used only for
  rate limits. Raw IPs are not stored in app tables.
- If the person sets one, the verified notice email.

**What it never learns:** the PRF output, the AMK, the passphrase, the identity private keys, the display
name (it stays E2EE in `profile_info`) and the recovery phrase. With attestation `none`, it does not learn
the authenticator model either.

**Properties and limits**
- A stolen database gives an attacker the wraps. They are useless without the authenticator: the
  PRF/hmac-secret key never leaves the device or the platform's passkey sync.
- Synced passkeys (iCloud Keychain, Google Password Manager) also sync the PRF secret. That makes them
  recoverable across devices, but it means the platform account protects the keys, much like a password
  manager.
- A malicious server could serve modified JavaScript that exfiltrates PRF outputs. This is the same
  web-E2EE limit as v1 (spec §2); native apps (phase 5) narrow it.
- The rpID is bound to the site. Passkeys registered on `localhost` or a preview domain don't work on
  `kithwall.com`.
- Losing every passkey with no recovery phrase saved and no trusted friends set up means the keys are
  gone. `removePasskey` stops people from doing this to themselves, and the UI should keep nudging.
- Trusted-friend recovery (spec §3.5) begins with "prove email control". Passkey accounts have no email,
  so for them recovery starts from a fresh sign-up session or the recovery phrase (see the open items
  below).
- Session minting relies on admin magic-link tokens. They are single use, expire, and are returned only
  after a verified passkey assertion. Nothing is emailed: synthetic addresses can't receive mail, and
  `generateLink` doesn't send.

## 6. Configuration

| Variable | Use |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | rpID = its hostname. Accepted origins are that origin and its `www.` twin. |
| `PASSKEY_RP_ID` / `NEXT_PUBLIC_PASSKEY_RP_ID` (optional) | Override the rpID, for example `kithwall.com` while serving from `www.kithwall.com`. Set the public one too, so the browser's local unlock uses the same rpID. |
| `PASSKEY_ORIGINS` (optional) | Comma-separated accepted origins when `PASSKEY_RP_ID` is set (default `https://<rpID>`). |
| `ALTCHA_HMAC_KEY` | Already required for sign-up. Also keys the IP tags and the passphrase decoys. |
| `SMTP_URL`, `MAIL_FROM` | Notice-email verification links. Without them, the link isn't sent. |

In development without `NEXT_PUBLIC_SITE_URL`, the rpID is the request host. It must be `localhost` or
`*.localhost`, because WebAuthn refuses IP addresses: use `http://localhost:<port>`, not `127.0.0.1`.

## 7. Tests

- `packages/crypto/test/passkey.test.ts`: PRF wrap/unwrap, binding to the salt, user and credential,
  tamper detection, and password-less bundles.
- `apps/web/src/lib/auth/passkey-shared.test.ts`: handles, synthetic addresses and bundle validation.
- `supabase/tests/passkeys.test.sql`: the creation RPC, RLS, challenge single use, counters, the
  last-unlock-method rule, MFA, and cascade on delete.
- `apps/web/src/lib/auth/passkey.e2e.test.ts`: the full API flow against a running dev server, using a
  software authenticator. It covers create → sign in → unlock, a second passkey, removal rules, notice
  email, passphrase accounts, v1 migration and ALTCHA single use. Run it with
  `E2E_BASE_URL=http://localhost:3011 npx vitest run src/lib/auth/passkey.e2e.test.ts`; it is skipped
  otherwise.

## 8. Open items

- Trusted-friend recovery for email-less accounts needs a new way to start a request, for example from a
  fresh passkey sign-up that claims the old handle.
- Rate limits for unauthenticated routes are counted from the challenge store per IP tag. The handle and
  lookup routes use per-instance memory. In production, add edge rate limiting (for example Vercel WAF).
