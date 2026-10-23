'use client';
// Mounted once from Providers: starts the censorship-resistance loop (lib/net/runtime.ts: mirror list,
// health checks, failover) and shows the calm connection banner. Renders nothing and starts nothing when
// no mirrors / proxy are configured (docs/v2/08-censorship.md).
import { useEffect } from 'react';
import { startNetLoop } from '@/lib/net/runtime';
import { setLearnedOrigins } from '@/lib/net/native';
import { useNet } from './useNet';
import { NetBanner } from './NetBanner';

export function NetRuntime() {
  const net = useNet();
  useEffect(() => startNetLoop(), []);
  // The Android app keeps the verified mirrors so it can fail over before any page loads.
  const origins = net.list?.mirrors.filter((m) => m.kind !== 'onion').map((m) => m.origin).join(',') ?? '';
  useEffect(() => { if (origins) void setLearnedOrigins(origins.split(',')); }, [origins]);
  if (!net.enabled) return null;
  return <NetBanner />;
}
