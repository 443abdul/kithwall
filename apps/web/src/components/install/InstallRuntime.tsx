'use client';
// Mounted once from Providers on every page: starts listening for the browser's install offer
// (lib/install.ts; public/theme.js already parked one that fired before hydration). Renders nothing.
import { useEffect } from 'react';
import { initInstall } from '@/lib/install';

export function InstallRuntime() {
  useEffect(() => { initInstall(); }, []);
  return null;
}
