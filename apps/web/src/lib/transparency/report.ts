'use client';
// "What Kithwall knows about you" (/you/privacy-report): the live inventory returned by the
// SECURITY DEFINER RPC public.transparency_report() (supabase/migrations/20261024000900_transparency.sql).
// It is built from the server's actual rows about the signed-in person, for that person only.
import { useQuery } from '@tanstack/react-query';
import { sb } from '../supabase';
import { useSession } from '../keys/session';
import type { ColumnClass, DataCategory } from './datamap';

export interface ReportTable {
  table: string;
  category: DataCategory;
  rows: number;
  first: string | null;
  last: string | null;
  /** Total bytes, for tables that record sizes (encrypted files). */
  bytes: number | null;
  retention: string;
  note: string | null;
  columns: Partial<Record<ColumnClass, string[]>>;
}

export interface TransparencyReport {
  version: 1;
  generated_at: string;
  account: {
    user_id: string;
    handle: string | null;
    created_at: string | null;
    auth_created_at: string | null;
    last_sign_in_at: string | null;
    email_kind: 'synthetic' | 'real' | 'none';
    email: string | null;
    synthetic_email: string | null;
    email_confirmed_at: string | null;
    notice_email: string | null;
    notice_email_verified_at: string | null;
    recovery_saved_at: string | null;
    mfa_factors: number;
    discoverable: boolean | null;
    directory_name: string | null;
    key_version: number | null;
    status: string | null;
    suspended_until: string | null;
  };
  passkeys: { label: string | null; created_at: string; last_used_at: string | null; backed_up: boolean | null; transports: string[] | null }[];
  sessions: { created_at: string; refreshed_at: string | null; user_agent: string | null; ip: string | null; aal: string | null }[];
  auth_log: { count: number; first: string | null; last: string | null };
  files: { count: number; bytes: number; first: string | null; last: string | null };
  tables: ReportTable[];
}

export async function fetchTransparencyReport(): Promise<TransparencyReport> {
  const { data, error } = await sb().rpc('transparency_report');
  if (error) throw new Error(error.message);
  const r = data as TransparencyReport;
  r.tables = (r.tables ?? []).map((x) => ({ ...x, rows: Number(x.rows) || 0, bytes: x.bytes == null ? null : Number(x.bytes), columns: x.columns ?? {} }));
  return r;
}

export function useTransparencyReport() {
  const { status, userId } = useSession();
  return useQuery({
    queryKey: ['transparency-report', userId],
    enabled: status === 'ready',
    staleTime: 0,
    queryFn: fetchTransparencyReport,
  });
}

/** The downloadable copy: the raw rows-derived report plus a key to read it. */
export function reportJson(r: TransparencyReport): string {
  return JSON.stringify({
    about: 'What Kithwall knows about you: generated live from the rows our server holds about your account. ' +
      'Counts and readable values only; the server cannot decrypt anything listed as ciphertext.',
    column_classes: {
      id: 'identifiers and links between rows (who / which item)',
      time: 'timestamps (when)',
      plaintext: 'other values the server can read (flags, sizes, roles, public keys, labels)',
      ciphertext: 'encrypted on your device; the server cannot read it',
      hashed: 'one-way hashes or random tokens that reveal nothing on their own',
    },
    outside_the_database: 'Hosting providers keep short-lived request logs (IP address, browser, page address) that are not in this report. See /transparency and the privacy policy.',
    report: r,
  }, null, 2);
}

export function reportFilename(r: TransparencyReport): string {
  return `kithwall-privacy-report-${r.account.handle ?? 'me'}-${r.generated_at.slice(0, 10)}.json`;
}

/** Totals for the summary line. */
export function reportTotals(r: TransparencyReport): { rows: number; tables: number; encryptedRows: number } {
  let rows = 0; let tables = 0; let encryptedRows = 0;
  for (const t of r.tables) {
    if (!t.rows) continue;
    rows += t.rows; tables++;
    if (t.columns.ciphertext?.length) encryptedRows += t.rows;
  }
  return { rows, tables, encryptedRows };
}

export function rowsOf(r: TransparencyReport, table: string): number {
  return r.tables.find((t) => t.table === table)?.rows ?? 0;
}
