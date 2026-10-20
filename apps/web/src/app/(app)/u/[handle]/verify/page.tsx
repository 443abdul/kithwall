import type { Metadata } from 'next';
import { VerifyScreen } from '@/components/verify/VerifyScreen';

// Safety number / contact verification (docs/v2/03-transparency.md §2).
export const metadata: Metadata = { title: 'Verify' };

export default async function Page({ params }: PageProps<'/u/[handle]/verify'>) {
  const { handle } = await params;
  return <VerifyScreen handle={handle.slice(0, 64)} />;
}
