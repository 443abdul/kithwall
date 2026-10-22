'use client';
// Inside the Android/iOS app only (docs/v2/05-native.md §1): starts lib/native/runtime.ts (Back button,
// downloads, share, status bar colour). In a browser this renders nothing and loads nothing.
import { useEffect } from 'react';
import { isNative } from '@/lib/native';

// navigator.share must exist before the components that test for it mount, so the stub is set as soon as
// this module runs; the real work loads with the runtime chunk.
if (typeof window !== 'undefined' && isNative() && typeof navigator.share !== 'function') {
  navigator.share = (data?: ShareData) => import('@/lib/native/runtime').then((m) => m.nativeShare(data));
}

export function NativeRuntime() {
  useEffect(() => {
    if (!isNative()) return;
    void import('@/lib/native/runtime').then((m) => m.startNativeRuntime());
  }, []);
  return null;
}
