import type { Metadata } from 'next';
import { BlockedHelp } from '@/components/net/BlockedHelp';

export const metadata: Metadata = { title: 'If Kithwall is blocked' };

export default function Page() {
  return <BlockedHelp />;
}
