import type { Metadata } from 'next';
import { SecuritySettings } from '@/components/settings/SecuritySettings';

export const metadata: Metadata = { title: 'Security' };

export default function Page() {
  return <SecuritySettings />;
}
