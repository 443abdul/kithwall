import type { Metadata } from 'next';
import { RecoverFlow } from '@/components/public/RecoverFlow';

export const metadata: Metadata = { title: 'Recover your account' };

export default function Page() {
  return <RecoverFlow />;
}
