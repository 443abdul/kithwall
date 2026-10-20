'use client';
import { useEffect, useMemo, useState } from 'react';
import { nextChange } from './ephemeral';

/**
 * "Now", re-rendering at the next moment one of these rows expires or goes live (phase 3), so expired
 * messages and posts leave the screen at once instead of waiting for the server's clock or a refetch.
 */
export function useClock(rows: { expires_at?: string | null; publish_at?: string | null }[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = useMemo(() => nextChange(rows, now), [rows, now]);
  useEffect(() => {
    if (next === null) return;
    // setTimeout caps at ~24.8 days; re-check at least daily.
    const h = setTimeout(() => setNow(Date.now()), Math.min(Math.max(250, next - Date.now() + 50), 86_400_000));
    return () => clearTimeout(h);
  }, [next]);
  return now;
}
