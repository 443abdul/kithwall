import type { Metadata } from 'next';
import { OfflineShell } from '@/components/net/OfflineShell';

// The offline entry point (public/sw.js keeps it; docs/v2/08-censorship.md §5). The same document for
// everyone: nothing about the person is rendered on the server.
export const metadata: Metadata = { title: 'Kit Drop' };

export default function Page() {
  return <OfflineShell />;
}
