import type { Metadata } from 'next';
import { KitDropScreen } from '@/components/posts/KitDrop';

export const metadata: Metadata = { title: 'Kit Drop' };

export default function Page() {
  return <KitDropScreen />;
}
