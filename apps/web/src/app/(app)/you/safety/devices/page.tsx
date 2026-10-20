import type { Metadata } from 'next';
import { Devices } from '@/components/safety/Devices';

export const metadata: Metadata = { title: 'Devices and sessions' };

export default function Page() {
  return <Devices />;
}
