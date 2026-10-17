import type { Metadata } from 'next';
import { ConversationList } from '@/components/messages/ConversationList';

export const metadata: Metadata = { title: 'Messages' };

export default function MessagesPage() {
  return <ConversationList />;
}
