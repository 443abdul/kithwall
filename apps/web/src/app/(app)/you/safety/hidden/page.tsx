import type { Metadata } from 'next';
import { HiddenChats } from '@/components/safety/HiddenChats';

export const metadata: Metadata = { title: 'Hidden chats' };

export default function Page() {
  return <HiddenChats />;
}
