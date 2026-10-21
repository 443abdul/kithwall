#!/usr/bin/env bash
# Kithwall launch rehearsal (docs/v2/07-launch.md §2). LOCAL ONLY.
#
# Builds a throwaway database `kw_launch_test` INSIDE the local Supabase Postgres container (the main
# `postgres` database that the local stack and other tools use is never touched), replays the v1
# migrations, loads v1-shaped data, applies the v2 migrations exactly as `supabase db push` would
# (each file in one transaction, as the `postgres` role), then runs verify_cutover.sql and every
# supabase/tests/*.sql file against it, and drops it.
#
#   bash supabase/launch/rehearse.sh                 # seed_v1_sample.sql as the v1 data
#   bash supabase/launch/rehearse.sh --data dump.sql # a data-only dump of production instead (see 07-launch.md §2.3)
#   bash supabase/launch/rehearse.sh --keep          # leave kw_launch_test for inspection (drop it yourself)
#
# Needs: docker, the local stack running (`npx supabase start`), run from the repo root.
# pg_cron can only live in the cluster's cron database, so the throwaway DB gets a small stand-in
# (`cron.schedule` records jobs in cron.job; nothing runs on a schedule). The migrations' own
# `create extension pg_cron` line is the only thing skipped.
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite /tmp paths for docker exec

C=${KW_DB_CONTAINER:-supabase_db_kithwall}
DB=kw_launch_test
LAST_V1=20261020000100
DATA=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument $1"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../.."
psql_admin() { docker exec -i "$C" psql -U supabase_admin -v ON_ERROR_STOP=1 -q "$@"; }

echo "== fresh $DB"
psql_admin -d postgres -c "drop database if exists $DB with (force);" -c "create database $DB owner postgres;"

echo "== auth / storage / realtime schemas (structure only, from the local stack)"
docker exec "$C" bash -c "pg_dump -U supabase_admin -d postgres --schema-only -n auth -n storage -n realtime -n extensions \
  | grep -v '^CREATE SCHEMA extensions;' > /tmp/kw_base.sql"
psql_admin -d "$DB" -c "create schema extensions; create extension pgcrypto with schema extensions;
  create extension \"uuid-ossp\" with schema extensions; grant usage on schema extensions to postgres, anon, authenticated, service_role;"
# The local stack's own app policies on storage.objects / realtime.messages refer to schema kw, which
# doesn't exist yet: those statements fail here and are recreated by the migrations.
docker exec "$C" psql -U supabase_admin -d "$DB" -q -f /tmp/kw_base.sql 2>&1 | grep ERROR | grep -v 'schema "kw" does not exist' || true
psql_admin -d "$DB" <<'SQL'
select format('drop policy %I on %I.%I', policyname, schemaname, tablename) from pg_policies \gexec
-- Supabase's grants on the public schema (a hosted project has these from its init scripts).
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role supabase_admin in schema public grant all on functions to postgres, anon, authenticated, service_role;
create publication supabase_realtime;
create extension if not exists pg_net;
create extension if not exists citext with schema extensions;
create extension if not exists pgtap with schema extensions;
create schema cron;
create table cron.job (jobid bigserial primary key, schedule text, command text, nodename text default 'localhost',
  nodeport int default 5432, database text default current_database(), username text default current_user,
  active boolean default true, jobname text unique);
create table cron.job_run_details (jobid bigint, runid bigserial, status text, start_time timestamptz);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
grant usage on schema cron to postgres; grant all on all tables in schema cron to postgres;
grant all on all sequences in schema cron to postgres; grant execute on all functions in schema cron to postgres;
SQL

apply() {  # apply migrations with prefix in [$1, $2]
  for f in supabase/migrations/*.sql; do
    b=$(basename "$f"); p=${b%%_*}
    if [[ "$p" < "$1" || "$p" > "$2" ]]; then continue; fi
    sed -e 's/^create extension if not exists pg_cron with schema pg_catalog;/-- (pg_cron: stand-in)/' "$f" \
      | docker exec -i "$C" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q --single-transaction -o /dev/null \
      || { echo "FAILED: $b"; exit 1; }
    echo "   ok $b"
  done
}

echo "== v1 migrations (production today)"
apply 00000000000000 "$LAST_V1"

if [ -n "$DATA" ]; then
  echo "== v1 data from $DATA"
  docker exec -i "$C" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 -q --single-transaction \
    -c "set session_replication_role = replica;" -f - < "$DATA"
  psql_admin -d "$DB" <<'SQL'
create schema if not exists launch;
create table launch.pre_counts as
  select c.relname::text as t,
         (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(c.relname), false, true, '')))[1]::text::int as n
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';
SQL
else
  echo "== v1 sample data (seed_v1_sample.sql)"
  docker exec -i "$C" psql -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 -q -o /dev/null < supabase/launch/seed_v1_sample.sql
fi

echo "== v2 migrations (what db push will apply)"
apply "$((LAST_V1 + 1))" 99999999999999

fail=0
run_tap() {  # $1 = file
  out=$(docker exec -i "$C" psql -U postgres -d "$DB" -X -At -v ON_ERROR_STOP=1 < "$1" 2>&1) || { echo "ERROR in $1"; echo "$out" | tail -5; fail=1; return; }
  n_ok=$(echo "$out" | grep -c '^ok ' || true); n_bad=$(echo "$out" | grep -c '^not ok' || true)
  echo "   $(basename "$1"): $n_ok ok, $n_bad not ok"
  if [ "$n_bad" != 0 ]; then echo "$out" | grep -A4 '^not ok'; fail=1; fi
}

if [ -z "$DATA" ]; then
  echo "== verify_cutover.sql"
  run_tap supabase/launch/verify_cutover.sql
else
  echo "== row counts (production data)"
  psql_admin -d "$DB" -At -c "select p.t || ': ' || p.n || ' -> ' || (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(p.t), false, true, '')))[1]::text
    from launch.pre_counts p where (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.' || quote_ident(p.t), false, true, '')))[1]::text::int <> p.n" \
    | sed 's/^/   CHANGED /'
fi

echo "== supabase/tests/*.sql on the migrated v1 database"
# The suites assume the default operator switches (Public audience off); v1 data may have it on.
psql_admin -d "$DB" -c "update public.app_settings set value = 'false'::jsonb where key = 'public_audience_enabled';"
for t in supabase/tests/*.sql; do run_tap "$t"; done

if [ "$KEEP" = 1 ]; then echo "== kept $DB"; else
  psql_admin -d postgres -c "drop database $DB with (force);"; echo "== dropped $DB"; fi
[ "$fail" = 0 ] && echo "REHEARSAL PASSED" || { echo "REHEARSAL FAILED"; exit 1; }
