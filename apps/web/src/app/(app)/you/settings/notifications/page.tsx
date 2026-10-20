import type { Metadata } from 'next';
import { NotificationSettings } from '@/components/settings/NotificationSettings';

export const metadata: Metadata = { title: 'Notifications' };

export default function Page() {
  return <NotificationSettings />;
}
