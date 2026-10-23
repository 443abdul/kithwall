import type { Metadata } from 'next';
import { ConnectionSettings } from '@/components/net/ConnectionSettings';

export const metadata: Metadata = { title: 'Connection' };

export default function Page() {
  return <ConnectionSettings />;
}
