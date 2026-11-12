'use client';
// Which accounts are run by Kithwall itself and post automatically (docs/v2/13-official-accounts.md). The
// list is public and tiny, so the app fetches it once and shows the "Automated" badge wherever one of these
// accounts appears, signed in or not. Only the service role can add an account to it.
import { useQuery } from '@tanstack/react-query';
import { sb, must } from '../supabase';
import type { AccountCard } from '../follow/follow';

export const automatedKey = ['automated-accounts'] as const;

export async function fetchAutomated(): Promise<AccountCard[]> {
  const rows = (must(await sb().rpc('automated_accounts')) ?? []) as { id: string; username: string; display_name: string | null }[];
  return rows.map((r) => ({ id: r.id, username: r.username, name: r.display_name }));
}

/** The automated accounts (empty until loaded, and when there are none). */
export function useAutomated(): AccountCard[] {
  return useQuery({ queryKey: automatedKey, queryFn: fetchAutomated, staleTime: 60 * 60_000, gcTime: 24 * 60 * 60_000, retry: 1 }).data ?? [];
}

/** Is this account one of Kithwall's automated ones? */
export function useIsAutomated(userId: string | null | undefined): boolean {
  const list = useAutomated();
  return !!userId && list.some((a) => a.id === userId);
}
