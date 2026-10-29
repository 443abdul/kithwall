-- Security hardening, batch 2 (docs/v2/roadmap-2026-11.md).
--
-- 1. Post-quantum key wrapping. Each person publishes an ML-KEM-768 public key (FIPS 203) derived from their
--    X25519 identity key, with an Ed25519 signature by their identity key over (user id, kx_pub, pq_pub)
--    (packages/crypto/src/pq.ts). Key deliveries to people who published one are hybrid sealed boxes
--    (seal v2: X25519 + ML-KEM-768), which stay secret unless BOTH are broken. Nothing changes for people
--    who haven't published one yet. The server can't forge the signature, and a substituted key could
--    only weaken the post-quantum half, never the classical one.
alter table public.profiles
  add column pq_pub text check (pq_pub is null or (char_length(pq_pub) between 1578 and 1580 and pq_pub ~ '^[A-Za-z0-9_-]+$')),
  add column pq_sig text check (pq_sig is null or (char_length(pq_sig) between 85 and 88 and pq_sig ~ '^[A-Za-z0-9_-]+=*$'));

insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.profiles', 'pq_pub', 'plaintext', 'post-quantum public key'),
  ('public.profiles', 'pq_sig', 'plaintext', 'signature over your public keys');

-- 2. Signed member additions. Whoever adds someone to a list, circle, event or conversation signs
--    (audience, member, added_by) with their identity key (packages/crypto/src/epoch.ts signMemberAdd).
--    Devices seal audience keys only to members whose addition verifies against someone entitled to add
--    them (apps/web/src/lib/keys/authority.ts memberVouched), so a member row the server inserted on its own
--    never receives keys. Rows from before this change are accepted as they are.
alter table public.audience_members
  add column add_by uuid references public.profiles (id) on delete set null,
  add column add_sig text check (add_sig is null or (char_length(add_sig) between 85 and 88 and add_sig ~ '^[A-Za-z0-9_-]+=*$'));

insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('public.audience_members', 'add_by', 'id', null),
  ('public.audience_members', 'add_sig', 'plaintext', 'signature of whoever added the member');
