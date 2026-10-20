import type { Metadata } from 'next';
import { DataSettings } from '@/components/settings/DataSettings';

export const metadata: Metadata = { title: 'Your data' };

export default function Page() {
  return <DataSettings />;
}
