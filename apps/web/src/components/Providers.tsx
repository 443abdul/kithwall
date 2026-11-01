'use client';
import { QueryClient, QueryClientProvider, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { initSession, useSession } from '@/lib/keys/session';
import { sb } from '@/lib/supabase';
import { keyring } from '@/lib/keys/keyring';
import { PushManager } from '@/components/push/PushManager';
import { InstallRuntime } from '@/components/install/InstallRuntime';
import { NativeRuntime } from '@/components/native/NativeRuntime';
import { NetRuntime } from '@/components/net/NetRuntime';
import { OfflineRuntime } from '@/components/net/OfflineRuntime';
import { invalidateSoon } from '@/lib/invalidate';
import { people } from '@/lib/people';
import { releaseFileUrls } from '@/lib/media';

// Someone's previous profile picture: free its decrypted copy once nothing shows it (lib/people).
people.setFileRelease((paths) => releaseFileUrls(paths));

export function Providers({ children }: { children: ReactNode; nonce?: string }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
  }));
  useEffect(() => { void initSession(); }, []);
  return (
    <QueryClientProvider client={qc}>
      <RealtimeBridge />
      <PushManager />
      <InstallRuntime />
      <NativeRuntime />
      <NetRuntime />
      <OfflineRuntime />
      {children}
    </QueryClientProvider>
  );
}

/**
 * Realtime events arrive in bursts (one message is an INSERT on messages plus updates to its conversation
 * and read state; a like comes back as our own echo), and every invalidation refetches each mounted query
 * under that key. Invalidations are coalesced for a moment, so each key is refetched once per burst.
 */
function useCoalescedInvalidate() {
  const qc = useQueryClient();
  const [batcher] = useState(() => {
    let likes = false;
    let all = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (all) {
        all = false;
        // New keys: re-read what may now decrypt. Likes and comments are plain rows decrypted while
        // rendering (cards re-render through useKeyringVersion), so the per-post queries are left alone.
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'likes' && q.queryKey[0] !== 'comments' });
      }
      if (likes) {
        likes = false;
        // Loaded on demand: the feed module isn't needed on pages without posts.
        import('@/lib/feed/feed').then((m) => m.refreshPostLikes(qc)).catch(() => { void qc.invalidateQueries({ queryKey: ['likes'] }); });
      }
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, 150); };
    return {
      key(k: QueryKey) { invalidateSoon(qc, k); },
      likes() { likes = true; schedule(); },
      all() { all = true; schedule(); },
      cancel() { if (timer) clearTimeout(timer); timer = null; likes = false; all = false; },
    };
  });
  return batcher;
}

/** Invalidate cached queries when the server tells us something changed (RLS-filtered). */
function RealtimeBridge() {
  const inv = useCoalescedInvalidate();
  const { status, userId } = useSession();
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const ch = sb().channel(`live:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => { inv.key(['notifications']); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' },
        () => { inv.key(['friends']); inv.key(['requests']); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (p) => {
          inv.key(['conversations']);
          inv.key(['messages', (p.new as { conversation_id: string }).conversation_id]);
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' },
        () => { inv.key(['conversations']); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' },
        (p) => { inv.key(['comments', (p.new as { post_id: string | null; photo_id: string | null }).post_id ?? (p.new as { photo_id: string }).photo_id]); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' },
        (p) => {
          // Only the post that was liked; anything else re-reads every visible post's likes in one batch.
          const row = p.new as { target_kind?: string; target_id?: string } | null;
          if (row?.target_kind === 'post' && row.target_id) inv.key(['likes', 'post', row.target_id]); // lib/feed/feed likesKey
          else inv.likes();
        })
      .subscribe();
    // Deletes are not published through postgres_changes (Realtime can't apply RLS to them, security
    // review D1): the database sends a content-free "something of yours changed" on db:<my id>, a private
    // topic only I can receive (supabase/migrations/20261028010100_authz_realtime.sql).
    let joined = false;
    const db = sb().channel(`db:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'change' }, ({ payload }) => {
        const t = (payload as { t?: unknown } | undefined)?.t;
        if (t === 'friendships') { inv.key(['friends']); inv.key(['requests']); }
        else if (t === 'likes') inv.likes();
        // A connection (or I, on another device) changed a profile: re-read the ones that changed
        // (the notice names no one; lib/people compares cheap stamps). 20261031000100_profile_info_live.sql
        else if (t === 'profile_info') people.requestSync();
      })
      .subscribe((state) => {
        // After a reconnect, notices sent while the socket was down are lost: catch up once.
        if (state === 'SUBSCRIBED') { if (joined) people.requestSync(); joined = true; }
      });
    // Back in the foreground (tab shown, app resumed, network back): catch up on missed profile changes.
    let last = 0;
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < 2_000) return;
      last = now;
      people.requestSync();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', resume);
    const unsub = keyring.subscribe(() => { inv.all(); });
    return () => {
      unsub(); inv.cancel(); void sb().removeChannel(ch); void sb().removeChannel(db);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('pageshow', resume);
    };
  }, [status, userId, inv]);
  return null;
}
