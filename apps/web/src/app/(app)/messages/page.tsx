import type { Metadata } from 'next';
import { MessagesScreen } from '@/components/shell/screens';

export const metadata: Metadata = { title: 'Messages' };

export default function Page() {
  return <MessagesScreen />;
}
