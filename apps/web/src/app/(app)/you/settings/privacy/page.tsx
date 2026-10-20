import type { Metadata } from 'next';
import { PrivacySettings } from '@/components/settings/PrivacySettings';

export const metadata: Metadata = { title: 'Privacy' };

export default function Page() {
  return <PrivacySettings />;
}
