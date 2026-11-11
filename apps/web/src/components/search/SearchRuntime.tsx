'use client';
// Search on your phone (lib/search): hands the unlocked account's key to the on-device index while "Search
// on this phone" is on, so content this device decrypts from then on can be found again. Nothing is read
// from storage here (that happens at the first search or the first new item), and nothing is sent anywhere.
import { useEffect } from 'react';
import { amk, useSession } from '@/lib/keys/session';
import { searchIndex } from '@/lib/search';
import { useSearchEnabled } from '@/lib/search/hooks';

export function SearchRuntime() {
  const { status, userId } = useSession();
  const enabled = useSearchEnabled();
  useEffect(() => {
    if (status !== 'ready' || !userId || !enabled) return;
    try { searchIndex.open(userId, amk()); } catch { /* locked in the meantime */ }
  }, [status, userId, enabled]);
  return null;
}
