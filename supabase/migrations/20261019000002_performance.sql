-- Performance (Supabase advisors): no behaviour change.

-- 1. RLS init-plan: evaluate auth.uid() once per statement instead of once per row by wrapping it in a
--    sub-select. Rewrites every policy in public (and storage.objects) that calls auth.uid() directly.
do $$
declare p record; q text; c text; stmt text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check from pg_policies
     where (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))
       and (coalesce(qual, '') ~ 'auth\.uid\(\)' or coalesce(with_check, '') ~ 'auth\.uid\(\)')
  loop
    q := regexp_replace(p.qual, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g');
    c := regexp_replace(p.with_check, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g');
    stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if q is not null then stmt := stmt || format(' using (%s)', q); end if;
    if c is not null then stmt := stmt || format(' with check (%s)', c); end if;
    execute stmt;
  end loop;
end $$;

-- 2. Index every foreign key in public whose columns aren't the leading columns of an existing index.
do $$
declare fk record; cols text; idx text;
begin
  for fk in
    select con.conrelid::regclass as tbl, con.conname, con.conkey, rel.relname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where con.contype = 'f' and n.nspname = 'public'
       and not exists (
         select 1 from pg_index i
          where i.indrelid = con.conrelid
            and (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] = con.conkey)
  loop
    select string_agg(quote_ident(a.attname), ', ' order by k.ord) into cols
      from unnest(fk.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = fk.tbl and a.attnum = k.attnum;
    idx := left(fk.relname || '_' || fk.conname || '_idx', 63);
    execute format('create index if not exists %I on %s (%s)', idx, fk.tbl, cols);
  end loop;
end $$;

-- 3. rate_events gets a primary key (lookups use the existing (user_id, action, at) index).
alter table kw.rate_events add column if not exists id bigint generated always as identity primary key;
