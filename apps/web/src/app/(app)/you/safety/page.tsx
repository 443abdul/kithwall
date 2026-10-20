import type { Metadata } from 'next';
import { SafetyCentre } from '@/components/safety/SafetyCentre';

export const metadata: Metadata = { title: 'Safety centre' };

export default function Page() {
  return <SafetyCentre />;
}
