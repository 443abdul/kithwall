import type { Metadata } from 'next';
import { SettingsScreen } from '@/components/shell/screens';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <SettingsScreen />;
}
