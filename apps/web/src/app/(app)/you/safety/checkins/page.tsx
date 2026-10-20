import type { Metadata } from 'next';
import { Checkins } from '@/components/safety/Checkins';

export const metadata: Metadata = { title: 'Check-ins' };

export default function Page() {
  return <Checkins />;
}
