'use client';
// Shared React Query hooks. Query keys are invalidated by the RealtimeBridge (Providers.tsx).
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useSession } from './keys/session';
import { keyring } from './keys/keyring';
import { incomingRequests, myFriendIds } from './friends';
import { fetchNotifications } from './notifications';
import { listConversations } from './messages';
import { people } from './people';
import { sb } from './supabase';

function useReady() { return useSession().status === 'ready'; }

/** Re-render when new keys arrive (so "waiting for key" items can decrypt). */
export function useKeyringVersion(): number {
  return useSyncExternalStore((l) => keyring.subscribe(l), () => keyring.version, () => 0);
}

export function useRequests() {
  const ready = useReady();
  return useQuery({
    queryKey: ['requests'], enabled: ready,
    queryFn: async () => { const r = await incomingRequests(); await people.ensure(r.map((x) => x.requested_by)); return r; },
  });
}

export function useFriendIds() {
  const ready = useReady();
  return useQuery({
    queryKey: ['friends', 'mine'], enabled: ready,
    queryFn: async () => { const ids = await myFriendIds(); await people.ensure(ids); return ids; },
  });
}

export function useNotifications(limit = 30) {
  const ready = useReady();
  return useQuery({ queryKey: ['notifications', limit], enabled: ready, queryFn: () => fetchNotifications(limit) });
}

export function useConversations() {
  const ready = useReady();
  return useQuery({ queryKey: ['conversations'], enabled: ready, queryFn: () => listConversations() });
}

export function useAppSetting(key: 'public_audience_enabled' | 'signups_enabled') {
  return useQuery({
    queryKey: ['setting', key], staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await sb().from('app_settings').select('value').eq('key', key).maybeSingle();
      return data?.value === true;
    },
  });
}

export function useIsStaff() {
  const ready = useReady();
  const { userId } = useSession();
  return useQuery({
    queryKey: ['staff', userId], enabled: ready,
    queryFn: async () => {
      const { data } = await sb().from('staff_roles').select('role').eq('user_id', userId!).maybeSingle();
      return (data?.role as 'admin' | 'moderator' | undefined) ?? null;
    },
  });
}
