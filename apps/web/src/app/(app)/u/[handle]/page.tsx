import type { Metadata } from 'next';
import { ProfileScreen } from '@/components/people/ProfileScreen';

// Profiles live at /u/<handle>: "@" can't start a folder name (it marks a parallel-route slot) and the
// v1 catch-all /[username] still exists until phase 2 ends.
export const metadata: Metadata = { title: 'Profile' };

export default async function Page({ params }: PageProps<'/u/[handle]'>) {
  const { handle } = await params;
  return <ProfileScreen handle={handle.slice(0, 64)} />;
}
