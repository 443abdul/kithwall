# Kithwall key-log witness

This branch is written only by the `kt-witness` GitHub Actions workflow. Once a day it fetches the
tree head of Kithwall's public key-transparency log (`/api/kt/head`), verifies an RFC 9162 consistency
proof from the head it recorded before, and commits the new head here:

- `head.json`: the latest witnessed head `{ size, root, at, witnessedAt, origin }`
- `heads.jsonl`: every witnessed head, one per line

If the log ever shrinks or its history is rewritten, the workflow fails and records nothing, so the last
commit here stays as evidence. Kithwall's apps can compare their own head with `head.json`
(Transparency page → Public key log). Design: `docs/v2/09-key-transparency.md` on the main branch.
