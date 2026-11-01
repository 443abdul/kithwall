-- Key transparency (roadmap 2026-11, batch 2 item 7; design: docs/v2/09-key-transparency.md).
--
-- A public, append-only Merkle log of every identity-key publication. Clients already pin contacts' keys
-- and check signed key changes (lib/keys/pins.ts); the log adds that the server cannot show anyone a key
-- that isn't in one global history, and cannot rewrite that history without every device that saw an
-- earlier head (and the public witness on the kt-heads branch) noticing.
--
--   kw.kt_leaves    one row per publication: its position and a salted commitment (32 bytes)
--   kw.kt_nodes     every complete subtree hash (level 0 = leaf hashes), so roots and proofs need only
--                   O(log n) lookups
--   kw.kt_heads     the signed-by-nobody but publicly witnessed tree head after every append:
--                   (size, root, time)
--   kw.kt_openings  who a leaf is about: user, key version, the keys and the random salt. Given only to
--                   signed-in people allowed to see that profile (kw.can_see_profile), deleted with the
--                   account. The leaf itself stays: without its opening it is an opaque random hash.
--
-- Hashing (packages/crypto merkle.ts / kt.ts, RFC 9162 §2.1):
--   commitment = SHA-256(lp('kithwall/v1/kt-commit') ‖ lp(user id) ‖ lp(sign_pub) ‖ lp(kx_pub) ‖ lp(u64be(version)) ‖ lp(salt))
--   leaf hash  = SHA-256(0x00 ‖ lp('kithwall/v1/kt-leaf') ‖ lp(commitment))
--   node hash  = SHA-256(0x01 ‖ left ‖ right)
--   lp(x)      = 4-byte big-endian length ‖ x
--
-- Writes: only kw.kt_publish(), called by an AFTER trigger on public.profiles for every insert (sign-up)
-- and every change of sign_pub / kx_pub (public.apply_identity_key_change, the only way keys change). No
-- role has INSERT/UPDATE/DELETE/TRUNCATE on the log tables, and triggers refuse UPDATE, DELETE and
-- TRUNCATE on leaves, nodes and heads for everyone, including the service role through the API. Appends
-- are serialised with a transaction-level advisory lock.
--
-- Reads (route handlers under app/api/kt, which anyone can call):
--   public.kt_head(size)            the latest head, or the head at a given size
--   public.kt_consistency(a, b)     RFC 9162 consistency proof between sizes a ≤ b
--   public.kt_inclusion(size, keys) for signed-in users: opening + inclusion proof of up to 50 people's
--                                   CURRENT keys, only for profiles the caller may see
--
-- Backfill: every existing profile's current keys get a leaf, oldest account first.

-- ---------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------
create table kw.kt_leaves (
  idx bigint primary key check (idx >= 0),
  commitment bytea not null check (octet_length(commitment) = 32),
  created_at timestamptz not null default clock_timestamp()
);

create table kw.kt_nodes (
  level smallint not null check (level between 0 and 62),
  idx bigint not null check (idx >= 0),
  hash bytea not null check (octet_length(hash) = 32),
  primary key (level, idx)
);

create table kw.kt_heads (
  size bigint primary key check (size >= 1),
  root bytea not null check (octet_length(root) = 32),
  created_at timestamptz not null default clock_timestamp()
);

create table kw.kt_openings (
  leaf_idx bigint primary key references kw.kt_leaves (idx),
  user_id uuid not null references public.profiles (id) on delete cascade,
  key_version int not null check (key_version >= 1),
  sign_pub text not null check (char_length(sign_pub) = 43),
  kx_pub text not null check (char_length(kx_pub) = 43),
  salt bytea not null check (octet_length(salt) = 32),
  created_at timestamptz not null default clock_timestamp()
);
create index kt_openings_user on kw.kt_openings (user_id, leaf_idx desc);

revoke all on kw.kt_leaves, kw.kt_nodes, kw.kt_heads, kw.kt_openings from public, anon, authenticated, service_role;

-- Append-only for everyone: leaves, nodes and heads are never updated, deleted or truncated. Openings are
-- deleted only with the account (the foreign-key cascade) and never edited.
create function kw.kt_refuse_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'the key-transparency log is append-only (%)', tg_table_name using errcode = '42501';
end $$;

create trigger kt_leaves_append_only before update or delete on kw.kt_leaves for each row execute function kw.kt_refuse_change();
create trigger kt_leaves_no_truncate before truncate on kw.kt_leaves for each statement execute function kw.kt_refuse_change();
create trigger kt_nodes_append_only before update or delete on kw.kt_nodes for each row execute function kw.kt_refuse_change();
create trigger kt_nodes_no_truncate before truncate on kw.kt_nodes for each statement execute function kw.kt_refuse_change();
create trigger kt_heads_append_only before update or delete on kw.kt_heads for each row execute function kw.kt_refuse_change();
create trigger kt_heads_no_truncate before truncate on kw.kt_heads for each statement execute function kw.kt_refuse_change();
create trigger kt_openings_immutable before update on kw.kt_openings for each row execute function kw.kt_refuse_change();
create trigger kt_openings_no_truncate before truncate on kw.kt_openings for each statement execute function kw.kt_refuse_change();

-- Leaves and heads only ever extend the log by exactly one.
create function kw.kt_next_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'kt_leaves' then
    if new.idx <> coalesce((select max(l.idx) from kw.kt_leaves l), -1) + 1 then
      raise exception 'key-transparency leaves are appended in order' using errcode = '42501';
    end if;
  elsif new.size <> coalesce((select max(h.size) from kw.kt_heads h), 0) + 1 then
    raise exception 'key-transparency heads grow one entry at a time' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger kt_leaves_in_order before insert on kw.kt_leaves for each row execute function kw.kt_next_only();
create trigger kt_heads_in_order before insert on kw.kt_heads for each row execute function kw.kt_next_only();

-- ---------------------------------------------------------------------------------------
-- 2. Hashing
-- ---------------------------------------------------------------------------------------
create function kw.kt_lp(b bytea) returns bytea
language sql immutable strict set search_path = '' as $$ select int4send(octet_length(b)) || b $$;

create function kw.kt_b64u(b bytea) returns text
language sql immutable strict set search_path = '' as $$
  select rtrim(translate(encode(b, 'base64'), E'+/\n', '-_'), '=')
$$;

create function kw.kt_commitment(p_user uuid, p_sign_pub text, p_kx_pub text, p_version int, p_salt bytea) returns bytea
language sql immutable strict set search_path = '' as $$
  select sha256(kw.kt_lp(convert_to('kithwall/v1/kt-commit', 'UTF8')) || kw.kt_lp(convert_to(lower(p_user::text), 'UTF8'))
    || kw.kt_lp(convert_to(p_sign_pub, 'UTF8')) || kw.kt_lp(convert_to(p_kx_pub, 'UTF8'))
    || kw.kt_lp(int8send(p_version::bigint)) || kw.kt_lp(p_salt))
$$;

create function kw.kt_leaf_hash(p_commitment bytea) returns bytea
language sql immutable strict set search_path = '' as $$
  select sha256('\x00'::bytea || kw.kt_lp(convert_to('kithwall/v1/kt-leaf', 'UTF8')) || kw.kt_lp(p_commitment))
$$;

create function kw.kt_node_hash(l bytea, r bytea) returns bytea
language sql immutable strict set search_path = '' as $$ select sha256('\x01'::bytea || l || r) $$;

-- Largest power of two strictly smaller than n (n >= 2).
create function kw.kt_split(n bigint) returns bigint
language plpgsql immutable strict set search_path = '' as $$
declare k bigint := 1;
begin
  while k * 2 < n loop k := k * 2; end loop;
  return k;
end $$;

-- MTH(D[lo:hi]) from the stored complete subtrees. Every range this is called with comes from splitting
-- [0, size) the RFC 9162 way, so a power-of-two range always starts on a multiple of its length.
create function kw.kt_mth(lo bigint, hi bigint) returns bytea
language plpgsql stable strict set search_path = '' as $$
declare n bigint := hi - lo; lvl int := 0; m bigint; h bytea; k bigint;
begin
  if n < 0 then raise exception 'bad range' using errcode = '22023'; end if;
  if n = 0 then return sha256(''::bytea); end if;
  if (n & (n - 1)) = 0 and lo % n = 0 then
    m := n;
    while m > 1 loop m := m >> 1; lvl := lvl + 1; end loop;
    select x.hash into h from kw.kt_nodes x where x.level = lvl and x.idx = lo / n;
    if h is null then raise exception 'key-transparency node (%, %) is missing', lvl, lo / n; end if;
    return h;
  end if;
  k := kw.kt_split(n);
  return kw.kt_node_hash(kw.kt_mth(lo, lo + k), kw.kt_mth(lo + k, hi));
end $$;

-- RFC 9162 PATH(m, D[lo:hi]): the inclusion proof of leaf lo + m.
create function kw.kt_path(m bigint, lo bigint, hi bigint) returns bytea[]
language plpgsql stable strict set search_path = '' as $$
declare n bigint := hi - lo; k bigint;
begin
  if n <= 1 then return '{}'::bytea[]; end if;
  k := kw.kt_split(n);
  if m < k then return kw.kt_path(m, lo, lo + k) || kw.kt_mth(lo + k, hi); end if;
  return kw.kt_path(m - k, lo + k, hi) || kw.kt_mth(lo, lo + k);
end $$;

-- RFC 9162 SUBPROOF(m, D[lo:hi], whole): the consistency proof from size m (relative to lo).
create function kw.kt_subproof(m bigint, lo bigint, hi bigint, whole boolean) returns bytea[]
language plpgsql stable strict set search_path = '' as $$
declare n bigint := hi - lo; k bigint;
begin
  if m = n then
    if whole then return '{}'::bytea[]; end if;
    return array[kw.kt_mth(lo, hi)];
  end if;
  k := kw.kt_split(n);
  if m <= k then return kw.kt_subproof(m, lo, lo + k, whole) || kw.kt_mth(lo + k, hi); end if;
  return kw.kt_subproof(m - k, lo + k, hi, false) || kw.kt_mth(lo, lo + k);
end $$;

-- Reference MTH over a list of leaf hashes, independent of the stored nodes (tests and audits).
create function kw.kt_mth_of(leaves bytea[]) returns bytea
language plpgsql immutable set search_path = '' as $$
declare n int := coalesce(cardinality(leaves), 0); k int;
begin
  if n = 0 then return sha256(''::bytea); end if;
  if n = 1 then return leaves[1]; end if;
  k := kw.kt_split(n)::int;
  return kw.kt_node_hash(kw.kt_mth_of(leaves[1:k]), kw.kt_mth_of(leaves[k + 1:n]));
end $$;

-- ---------------------------------------------------------------------------------------
-- 3. Appending
-- ---------------------------------------------------------------------------------------
-- Appends one commitment and the new head; returns the leaf's index. Serialised: one append at a time.
create function kw.kt_append(p_commitment bytea) returns bigint
language plpgsql security definer set search_path = '' as $$
declare n bigint; h bytea; lvl int := 0; i bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('kithwall/kt-append', 0));
  select coalesce(max(x.size), 0) into n from kw.kt_heads x;
  h := kw.kt_leaf_hash(p_commitment);
  insert into kw.kt_leaves (idx, commitment) values (n, p_commitment);
  insert into kw.kt_nodes (level, idx, hash) values (0, n, h);
  -- Every subtree this leaf completes: while the node is a right child, hash it with its left sibling.
  i := n;
  while i % 2 = 1 loop
    select kw.kt_node_hash(x.hash, h) into h from kw.kt_nodes x where x.level = lvl and x.idx = i - 1;
    lvl := lvl + 1;
    i := i / 2;
    insert into kw.kt_nodes (level, idx, hash) values (lvl, i, h);
  end loop;
  insert into kw.kt_heads (size, root) values (n + 1, kw.kt_mth(0, n + 1));
  return n;
end $$;

-- Logs one identity-key publication with a fresh random salt and keeps its opening.
create function kw.kt_publish(p_user uuid, p_sign_pub text, p_kx_pub text, p_version int) returns bigint
language plpgsql security definer set search_path = '' as $$
declare s bytea := extensions.gen_random_bytes(32); i bigint;
begin
  i := kw.kt_append(kw.kt_commitment(p_user, p_sign_pub, p_kx_pub, p_version, s));
  insert into kw.kt_openings (leaf_idx, user_id, key_version, sign_pub, kx_pub, salt)
    values (i, p_user, p_version, p_sign_pub, p_kx_pub, s);
  return i;
end $$;

create function kw.kt_profiles_publish() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform kw.kt_publish(new.id, new.sign_pub, new.kx_pub, new.key_version);
  return null;
end $$;

-- Backfill under a lock so no sign-up slips between the backfill and the trigger.
lock table public.profiles in share row exclusive mode;

do $$
declare r record;
begin
  for r in select p.id, p.sign_pub, p.kx_pub, p.key_version from public.profiles p order by p.created_at, p.id loop
    perform kw.kt_publish(r.id, r.sign_pub, r.kx_pub, r.key_version);
  end loop;
end $$;

create trigger kt_publish_new_key after insert on public.profiles
  for each row execute function kw.kt_profiles_publish();
create trigger kt_publish_changed_key after update of sign_pub, kx_pub on public.profiles
  for each row when (old.sign_pub is distinct from new.sign_pub or old.kx_pub is distinct from new.kx_pub)
  execute function kw.kt_profiles_publish();

-- ---------------------------------------------------------------------------------------
-- 4. Reading
-- ---------------------------------------------------------------------------------------
-- The latest tree head, or the head at p_size. Empty when the log is empty (or no such size).
create function public.kt_head(p_size bigint default null) returns table (size bigint, root text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select h.size, kw.kt_b64u(h.root), h.created_at from kw.kt_heads h
   where p_size is null or h.size = p_size
   order by h.size desc limit 1
$$;

-- RFC 9162 consistency proof that the tree of p_from leaves is a prefix of the tree of p_to leaves.
create function public.kt_consistency(p_from bigint, p_to bigint) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare n bigint; res text[];
begin
  select coalesce(max(h.size), 0) into n from kw.kt_heads h;
  if p_from is null or p_to is null or p_from < 1 or p_from > p_to or p_to > n then
    raise exception 'sizes must satisfy 1 <= from <= to <= %', n using errcode = '22023';
  end if;
  select coalesce(array_agg(kw.kt_b64u(t.x) order by t.ord), '{}') into res
    from unnest(kw.kt_subproof(p_from, 0, p_to, true)) with ordinality as t(x, ord);
  return res;
end $$;

-- Openings and inclusion proofs (at tree size p_size, default the latest) for the CURRENT published keys
-- of up to 50 people: p_keys = [{ "user": uuid, "signPub": text, "kxPub": text }, …]. Per person:
--   ok       the keys are in the log: leaf index, key version, salt and audit path
--   missing  no publication of exactly these keys for this person exists in the log
--   later    it exists, but after p_size (fetch a newer head and ask again)
--   hidden   the caller may not see this profile (kw.can_see_profile): nothing else is revealed
create function public.kt_inclusion(p_size bigint, p_keys jsonb)
returns table (user_id uuid, status text, leaf_index bigint, key_version int, salt text, proof text[])
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); n bigint; e jsonb; o record;
begin
  if me is null or not kw.mfa_ok() then raise exception 'not signed in' using errcode = '42501'; end if;
  if jsonb_typeof(p_keys) is distinct from 'array' or jsonb_array_length(p_keys) > 50 then
    raise exception 'keys must be an array of at most 50 entries' using errcode = '22023';
  end if;
  select max(h.size) into n from kw.kt_heads h;
  if p_size is not null then
    if p_size < 1 or p_size > coalesce(n, 0) then raise exception 'no such tree size' using errcode = '22023'; end if;
    n := p_size;
  end if;
  perform kw.rate_limit('kt_lookup', 600, interval '1 hour');
  for e in select x from jsonb_array_elements(p_keys) as t(x) loop
    if jsonb_typeof(e) is distinct from 'object' or coalesce(e ->> 'user', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bad entry' using errcode = '22023';
    end if;
    user_id := (e ->> 'user')::uuid;
    leaf_index := null; key_version := null; salt := null; proof := null;
    if not kw.can_see_profile(user_id, me) then
      status := 'hidden';
      return next;
      continue;
    end if;
    select k.leaf_idx, k.key_version, k.salt into o from kw.kt_openings k
     where k.user_id = (e ->> 'user')::uuid and k.sign_pub = e ->> 'signPub' and k.kx_pub = e ->> 'kxPub'
     order by k.leaf_idx desc limit 1;
    if not found then
      status := 'missing';
    elsif n is null or o.leaf_idx >= n then
      status := 'later'; leaf_index := o.leaf_idx;
    else
      status := 'ok'; leaf_index := o.leaf_idx; key_version := o.key_version; salt := kw.kt_b64u(o.salt);
      select coalesce(array_agg(kw.kt_b64u(t.x) order by t.ord), '{}') into proof
        from unnest(kw.kt_path(o.leaf_idx, 0, n)) with ordinality as t(x, ord);
    end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------
-- 5. Data map (transparency)
-- ---------------------------------------------------------------------------------------
insert into kw.data_map_tables (table_name, category, owner_pred, time_col, size_col, retention, note) values
  ('kw.kt_leaves', 'system', null, null, null, 'For as long as Kithwall runs (the public key log is append-only)',
   'The public key log: one random-looking hash per published identity key. Without its opening it says nothing about whose key it is.'),
  ('kw.kt_nodes', 'system', null, null, null, 'For as long as Kithwall runs', 'Hashes of the public key log''s tree.'),
  ('kw.kt_heads', 'system', null, null, null, 'For as long as Kithwall runs', 'The public key log''s size and root after every entry.'),
  ('kw.kt_openings', 'account', 't.user_id = $1', 'created_at', null, 'Until you delete your account',
   'Which entry of the public key log is your key, shown only to people who can see your profile.');
insert into kw.data_map_columns (table_name, column_name, class, note) values
  ('kw.kt_leaves', 'idx', 'plaintext', 'position in the log'), ('kw.kt_leaves', 'commitment', 'hashed', 'salted commitment to a key'),
  ('kw.kt_leaves', 'created_at', 'time', null),
  ('kw.kt_nodes', 'level', 'plaintext', null), ('kw.kt_nodes', 'idx', 'plaintext', null), ('kw.kt_nodes', 'hash', 'hashed', null),
  ('kw.kt_heads', 'size', 'plaintext', null), ('kw.kt_heads', 'root', 'hashed', null), ('kw.kt_heads', 'created_at', 'time', null),
  ('kw.kt_openings', 'leaf_idx', 'id', null), ('kw.kt_openings', 'user_id', 'id', null),
  ('kw.kt_openings', 'key_version', 'plaintext', null), ('kw.kt_openings', 'sign_pub', 'plaintext', 'public key'),
  ('kw.kt_openings', 'kx_pub', 'plaintext', 'public key'), ('kw.kt_openings', 'salt', 'hashed', 'random'),
  ('kw.kt_openings', 'created_at', 'time', null);

-- ---------------------------------------------------------------------------------------
-- Execute rights
-- ---------------------------------------------------------------------------------------
revoke execute on function kw.kt_refuse_change(), kw.kt_next_only(), kw.kt_lp(bytea), kw.kt_b64u(bytea),
  kw.kt_commitment(uuid, text, text, int, bytea), kw.kt_leaf_hash(bytea), kw.kt_node_hash(bytea, bytea), kw.kt_split(bigint),
  kw.kt_mth(bigint, bigint), kw.kt_path(bigint, bigint, bigint), kw.kt_subproof(bigint, bigint, bigint, boolean),
  kw.kt_mth_of(bytea[]), kw.kt_append(bytea), kw.kt_publish(uuid, text, text, int), kw.kt_profiles_publish()
  from public, anon, authenticated, service_role;
revoke execute on function public.kt_head(bigint), public.kt_consistency(bigint, bigint), public.kt_inclusion(bigint, jsonb)
  from public;
grant execute on function public.kt_head(bigint), public.kt_consistency(bigint, bigint) to anon, authenticated, service_role;
revoke execute on function public.kt_inclusion(bigint, jsonb) from anon;
grant execute on function public.kt_inclusion(bigint, jsonb) to authenticated;
