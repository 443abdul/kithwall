import type { Metadata } from 'next';
import { ModScreen } from '@/components/mod/ModScreen';

// Moderators and admins only (staff_roles); everyone else sees "no access". RLS enforces it server-side.
export const metadata: Metadata = { title: 'Moderation' };

export default function Page() {
  return <ModScreen />;
}
