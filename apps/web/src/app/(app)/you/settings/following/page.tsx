import type { Metadata } from 'next';
import { FollowSettings } from '@/components/settings/FollowSettings';

// Following and public posts (docs/v2/10-follow-public.md): who can follow, comment and mention; hidden words.
export const metadata: Metadata = { title: 'Following and public posts' };

export default function Page() {
  return <FollowSettings />;
}
