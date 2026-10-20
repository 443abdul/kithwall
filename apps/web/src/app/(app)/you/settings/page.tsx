import type { Metadata } from 'next';
import { SettingsIndex } from '@/components/settings/SettingsIndex';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <SettingsIndex />;
}
