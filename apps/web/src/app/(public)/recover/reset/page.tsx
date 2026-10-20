import type { Metadata } from 'next';
import { RecoverReset } from '@/components/public/RecoverReset';

// Landing page of the v1 "forgot password" email (redirectTo in components/public/RecoverFlow.tsx).
export const metadata: Metadata = { title: 'Recover your account' };

export default function Page() {
  return <RecoverReset />;
}
