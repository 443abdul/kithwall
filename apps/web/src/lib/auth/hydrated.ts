'use client';
// False during server rendering and hydration, true afterwards. Submit buttons of forms that carry
// passwords or emails stay disabled until React handles them, so an early click/Enter can never
// fall back to a native GET submission that would put the fields in the URL.
import { useSyncExternalStore } from 'react';

const noop = () => () => undefined;
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
