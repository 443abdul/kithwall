import type { Metadata } from 'next';
import { SetupFlow } from '@/components/onboarding/SetupFlow';

export const metadata: Metadata = { title: 'Finish setting up' };

export default function Page() {
  return <SetupFlow />;
}
