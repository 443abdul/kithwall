// Pure helpers for keeping cached profiles fresh (lib/people.ts). Kept free of Supabase and React so the
// invalidation rules can be unit-tested (peopleSync.test.ts).

/** The cheap, non-secret part of a profile_info row: enough to tell whether the sealed envelope changed. */
export interface InfoStamp { user_id: string; audience_id: string; epoch: number; updated_at: string }

/**
 * Compare the stamps this device holds with fresh ones from the server, for the people that were asked
 * about. `changed`: re-read these rows (new or edited, or re-sealed to another epoch). `gone`: the row is
 * no longer readable (deleted, or the connection ended), so drop what is cached.
 */
export function staleInfos(cached: ReadonlyMap<string, InfoStamp>, asked: Iterable<string>, fresh: readonly InfoStamp[]): { changed: string[]; gone: string[] } {
  const byUser = new Map<string, InfoStamp[]>();
  for (const r of fresh) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r); else byUser.set(r.user_id, [r]);
  }
  const changed: string[] = [];
  const gone: string[] = [];
  for (const id of new Set(asked)) {
    const now = byUser.get(id);
    const had = cached.get(id);
    if (!now?.length) { if (had) gone.push(id); continue; }
    if (!had) { changed.push(id); continue; }
    const same = now.find((r) => r.audience_id === had.audience_id);
    if (!same || same.epoch !== had.epoch || same.updated_at !== had.updated_at) changed.push(id);
  }
  return { changed, gone };
}

/** Storage paths a profile no longer uses once `next` replaces `prev` (their decrypted URLs can be freed). */
export function droppedPaths(prev: readonly string[] | undefined, next: readonly string[]): string[] {
  if (!prev?.length) return [];
  const keep = new Set(next);
  return prev.filter((p) => !keep.has(p));
}

/**
 * Run `task` at most once at a time: requests made in a burst (several realtime notices, a focus and a
 * visibility event together) are folded into one run after `waitMs`, and a request that arrives while a
 * run is in flight schedules exactly one more run after it.
 */
export function coalescer(task: () => Promise<void>, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  const fire = async () => {
    timer = null;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { await task(); } catch { /* offline or signed out: the next request retries */ }
    finally {
      running = false;
      if (again && !stopped) { again = false; request(); }
    }
  };
  function request() {
    if (stopped) return;
    if (running) { again = true; return; }
    if (!timer) timer = setTimeout(() => { void fire(); }, waitMs);
  }
  return {
    request,
    /** Stop for good (pending and follow-up runs are dropped). */
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; again = false; },
  };
}
