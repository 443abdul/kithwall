import type { Metadata } from 'next';
import { AppsSettings } from '@/components/settings/AppsSettings';

export const metadata: Metadata = { title: 'Apps' };

export default function Page() {
  return <AppsSettings />;
}
