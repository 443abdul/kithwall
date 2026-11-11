// Suggested accounts (docs/v2/10-follow-public.md §5), ranked ON THIS DEVICE. The server hands over one
// plain list: which follow-enabled accounts my connections follow (only connections who left "Show who I
// follow to my connections" on; public.connections_following). Counting, ordering, leaving out the accounts
// I already follow, muted or dismissed, and remembering what I dismissed (encrypted vault) all happen here,
// so the server never learns which suggestions I saw, opened or waved away. Pure: tested in suggest.test.ts.

export interface FollowEdge { followee_id: string; username: string; display_name: string | null; follower_id: string }

export interface Suggestion {
  id: string; username: string; name: string | null;
  /** My connections who follow this account, in the order the server listed them. */
  via: string[];
}

export interface SuggestOptions {
  me: string;
  /** Accounts I already follow, am connected to, or sent a request to. */
  known: Iterable<string>;
  /** Accounts I dismissed from suggestions or muted. */
  hidden?: Iterable<string>;
  limit?: number;
}

/** Most-followed-by-my-connections first; ties by handle so the order is stable between visits. */
export function rankSuggestions(edges: readonly FollowEdge[], opts: SuggestOptions): Suggestion[] {
  const skip = new Set<string>([opts.me, ...opts.known, ...(opts.hidden ?? [])]);
  const by = new Map<string, Suggestion>();
  for (const e of edges) {
    if (!e?.followee_id || !e.follower_id || skip.has(e.followee_id) || e.follower_id === opts.me) continue;
    let s = by.get(e.followee_id);
    if (!s) { s = { id: e.followee_id, username: e.username, name: e.display_name ?? null, via: [] }; by.set(e.followee_id, s); }
    if (!s.via.includes(e.follower_id)) s.via.push(e.follower_id);
  }
  return [...by.values()]
    .sort((a, b) => b.via.length - a.via.length || a.username.localeCompare(b.username))
    .slice(0, Math.max(0, opts.limit ?? 12));
}
