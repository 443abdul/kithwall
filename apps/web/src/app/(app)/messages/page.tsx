import type { Metadata } from 'next';
import { ChatPlaceholder } from '@/components/messages/ChatPlaceholder';

export const metadata: Metadata = { title: 'Messages' };

export default function Page() {
  return <ChatPlaceholder />;
}
