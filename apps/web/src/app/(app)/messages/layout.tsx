// Messages (Kithwall 2): the conversation list stays mounted while chats open beside it (or over it on phones).
import { MessagesLayout } from '@/components/messages/MessagesLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <MessagesLayout>{children}</MessagesLayout>;
}
