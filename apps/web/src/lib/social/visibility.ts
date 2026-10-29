'use client';
// Who sees each profile field (Settings → Privacy → Profile). Three tiers:
//  - 'connections' (default): sealed to my connections audience with the rest of my profile;
//  - 'close': encrypted again, inside that envelope, with my close friends list key (lib/social/closeFriends),
//    so only people on the list can open it (the outer signature still covers it);
//  - 'me': never published; kept in my encrypted vault ('profilePrivate') so the editor can show it.
// The tier map itself is in the vault too ('profileVisibility'); the server never learns it.
import { useSyncExternalStore } from 'react';
import type { ProfileInfo } from '../types';
import type { VisibilityMap } from './profileTiers';
import { vaultGet, vaultUpdate } from '../settings';
import { onLock } from '../keys/session';

export * from './profileTiers';

const NS = 'profileVisibility';
export const PRIVATE_NS = 'profilePrivate';


let current: VisibilityMap = {};
let loaded = false;
const listeners = new Set<() => void>();
const publish = (m: VisibilityMap) => { current = m; loaded = true; listeners.forEach((l) => l()); };
onLock(() => { current = {}; loaded = false; listeners.forEach((l) => l()); });

export async function loadVisibility(force = false): Promise<VisibilityMap> {
  if (loaded && !force) return current;
  publish((await vaultGet<VisibilityMap>(NS)) ?? {});
  return current;
}

export async function saveVisibility(patch: VisibilityMap): Promise<VisibilityMap> {
  const next = await vaultUpdate<VisibilityMap>(NS, (prev) => ({ ...(prev ?? {}), ...patch }));
  publish(next);
  return next;
}

export function useVisibility(): VisibilityMap {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current, () => current);
}

/** My 'only me' fields (for the editor and for re-saving without losing them). */
export async function myPrivateFields(): Promise<Partial<ProfileInfo>> {
  return (await vaultGet<Partial<ProfileInfo>>(PRIVATE_NS)) ?? {};
}

export async function saveMyPrivateFields(fields: Partial<ProfileInfo>): Promise<void> {
  await vaultUpdate<Partial<ProfileInfo>>(PRIVATE_NS, () => fields);
}
