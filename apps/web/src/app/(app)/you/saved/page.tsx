import type { Metadata } from 'next';
import { SavedScreen } from '@/components/posts/Saved';

export const metadata: Metadata = { title: 'Saved' };

export default function Page() {
  return <SavedScreen />;
}
