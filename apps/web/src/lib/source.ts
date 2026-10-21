// Where this running copy of Kithwall's source lives (AGPL-3.0 §13: users interacting with the app over a
// network must be offered its Corresponding Source). The commit is inlined at build time from
// VERCEL_GIT_COMMIT_SHA by next.config.ts (NEXT_PUBLIC_COMMIT_SHA). Forks: change REPO_URL to your own
// repository, or set NEXT_PUBLIC_SOURCE_REPO at build time.

const DEFAULT_REPO = 'https://github.com/443abdul/kithwall';

/** An https URL without credentials, query or fragment (trailing slashes dropped), else null. */
export function cleanRepoUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/** A full or abbreviated lowercase git commit hash, else null. */
export function cleanCommit(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(s) ? s : null;
}

export const REPO_URL = cleanRepoUrl(process.env.NEXT_PUBLIC_SOURCE_REPO) ?? DEFAULT_REPO;
export const COMMIT_SHA = cleanCommit(process.env.NEXT_PUBLIC_COMMIT_SHA);
export const LICENSE_ID = 'AGPL-3.0-only';

/** The source tree of exactly this build when the commit is known, else the repository. */
export function sourceUrl(repo = REPO_URL, commit = COMMIT_SHA): string {
  return commit ? `${repo}/tree/${commit}` : repo;
}

/** A file or folder in the repository at this build's commit (or the default branch). */
export function repoFileUrl(path: string, repo = REPO_URL, commit = COMMIT_SHA): string {
  return `${repo}/blob/${commit ?? 'HEAD'}/${path.replace(/^\/+/, '')}`;
}

export const shortCommit = (c: string | null = COMMIT_SHA) => (c ? c.slice(0, 7) : null);
