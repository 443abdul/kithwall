import type { Metadata } from 'next';
import { SafetyTips } from '@/components/safety/SafetyTips';

export const metadata: Metadata = { title: 'Safety tips' };

export default function Page() {
  return <SafetyTips />;
}
