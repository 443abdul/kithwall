import type { Metadata } from 'next';
import { LockSettings } from '@/components/safety/LockSettings';

export const metadata: Metadata = { title: 'App lock' };

export default function Page() {
  return <LockSettings />;
}
