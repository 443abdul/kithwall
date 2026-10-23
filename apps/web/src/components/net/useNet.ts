'use client';
import { useSyncExternalStore } from 'react';
import { netServerState, netState, subscribeNet, type NetState } from '@/lib/net/runtime';

/** The censorship-resistance runtime state (lib/net/runtime.ts). */
export function useNet(): NetState {
  return useSyncExternalStore(subscribeNet, netState, netServerState);
}
