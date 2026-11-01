// The public witness of the key log (docs/v2/09-key-transparency.md §5): a scheduled GitHub Actions job
// (.github/workflows/kt-witness.yml) fetches the production tree head every day, checks it is consistent
// with the head it committed before, and commits it to the repository's `kt-heads` branch. Anyone can read
// that history; a device can compare its own head with the latest witnessed one (only when the person asks:
// it is a request to GitHub). Pure; unit-tested in core.test.ts.
import { REPO_URL } from '../source';

export const KT_WITNESS_BRANCH = 'kt-heads';

export interface KtWitness {
  /** The branch on GitHub, for people. */
  branchUrl: string;
  /** The latest witnessed head as JSON (raw.githubusercontent.com). */
  headUrl: string;
}

/** Witness locations for a GitHub repository URL, or null for repositories hosted elsewhere. */
export function witnessFor(repo: string | null | undefined): KtWitness | null {
  if (!repo) return null;
  let u: URL;
  try { u = new URL(repo); } catch { return null; }
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(u.pathname);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !m) return null;
  return {
    branchUrl: `https://github.com/${m[1]}/${m[2]}/tree/${KT_WITNESS_BRANCH}`,
    headUrl: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${KT_WITNESS_BRANCH}/head.json`,
  };
}

export const KT_WITNESS = witnessFor(REPO_URL);
