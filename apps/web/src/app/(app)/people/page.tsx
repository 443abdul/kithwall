import type { Metadata } from 'next';
import { PeopleScreen } from '@/components/people/PeopleScreen';

// Connections, requests, invite link + QR, and find-by-handle (/search is still the v1 page).
export const metadata: Metadata = { title: 'Connections' };

export default async function Page({ searchParams }: PageProps<'/people'>) {
  const { invite, tab } = await searchParams;
  const code = typeof invite === 'string' && /^[0-9a-f]{8,64}$/i.test(invite) ? invite : undefined;
  const initial = tab === 'invite' || tab === 'requests' || tab === 'connections' ? tab : undefined;
  return <PeopleScreen key={code ?? ''} invite={code} initialTab={initial} />;
}
