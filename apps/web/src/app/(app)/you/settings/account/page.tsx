import type { Metadata } from 'next';
import { AccountSettings } from '@/components/settings/AccountSettings';

export const metadata: Metadata = { title: 'Account' };

export default function Page() {
  return <AccountSettings />;
}
