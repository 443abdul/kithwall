'use client';
// Mounted once from Providers. Renders nothing. Kit Drop without the internet (docs/v2/08-censorship.md §5):
//  - signed in and online: register the service worker and ask it to keep this build's offline shell
//    (lib/net/shell.ts; static files only), and send posts that waited in the outbox;
//  - signed out on purpose: delete the shell.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onLock, useSession } from '@/lib/keys/session';
import { registerServiceWorker } from '@/lib/push';
import { dropOfflineShell, keepOfflineShell } from '@/lib/net/shell';

export function OfflineRuntime() {
  const qc = useQueryClient();
  const { status, userId, offline } = useSession();
  const online = status === 'ready' && !!userId && !offline;

  useEffect(() => {
    if (!online) return;
    let live = true;
    void registerServiceWorker()?.then((reg) => (live ? keepOfflineShell(reg) : false)).catch(() => undefined);
    // Back online (or just signed in): what was written offline goes out now, oldest first.
    void import('@/lib/social/kitdrop').then((m) => m.flushOutbox()).then((n) => {
      if (n && live) { void qc.invalidateQueries({ queryKey: ['v2feed'] }); void qc.invalidateQueries({ queryKey: ['kitdrop-outbox'] }); }
    }).catch(() => undefined);
    return () => { live = false; };
  }, [online, qc]);

  useEffect(() => onLock((reason) => { if (reason === 'sign_out') void dropOfflineShell(); }), []);
  return null;
}
