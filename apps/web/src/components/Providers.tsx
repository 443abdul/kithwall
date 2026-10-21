'use client';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { initSession, useSession } from '@/lib/keys/session';
import { sb } from '@/lib/supabase';
import { keyring } from '@/lib/keys/keyring';
import { PushManager } from '@/components/push/PushManager';

export function Providers({ children }: { children: ReactNode; nonce?: string }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
  }));
  useEffect(() => { void initSession(); }, []);
  return (
    <QueryClientProvider client={qc}>
      <RealtimeBridge />
      <PushManager />
      {children}
    </QueryClientProvider>
  );
}

/** Invalidate cached queries when the server tells us something changed (RLS-filtered). */
function RealtimeBridge() {
  const qc = useQueryClient();
  const { status, userId } = useSession();
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const ch = sb().channel(`live:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
        () => { void qc.invalidateQueries({ queryKey: ['friends'] }); void qc.invalidateQueries({ queryKey: ['requests'] }); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (p) => {
          void qc.invalidateQueries({ queryKey: ['conversations'] });
          void qc.invalidateQueries({ queryKey: ['messages', (p.new as { conversation_id: string }).conversation_id] });
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' },
        () => { void qc.invalidateQueries({ queryKey: ['conversations'] }); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' },
        (p) => { void qc.invalidateQueries({ queryKey: ['comments', (p.new as { post_id: string | null; photo_id: string | null }).post_id ?? (p.new as { photo_id: string }).photo_id] }); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' },
        () => { void qc.invalidateQueries({ queryKey: ['likes'] }); })
      .subscribe();
    // Deletes are not published through postgres_changes (Realtime can't apply RLS to them, security
    // review D1): the database sends a content-free "something of yours changed" on db:<my id>, a private
    // topic only I can receive (supabase/migrations/20261028010100_authz_realtime.sql).
    const db = sb().channel(`db:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'change' }, ({ payload }) => {
        const t = (payload as { t?: unknown } | undefined)?.t;
        if (t === 'friendships') { void qc.invalidateQueries({ queryKey: ['friends'] }); void qc.invalidateQueries({ queryKey: ['requests'] }); }
        else if (t === 'likes') void qc.invalidateQueries({ queryKey: ['likes'] });
      })
      .subscribe();
    const unsub = keyring.subscribe(() => { void qc.invalidateQueries(); });
    return () => { unsub(); void sb().removeChannel(ch); void sb().removeChannel(db); };
  }, [status, userId, qc]);
  return null;
}
