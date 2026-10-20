'use client';
import { use } from 'react';
import { ProfileFrame } from '@/components/profile/ProfileFrame';
import { InfoTab } from '@/components/profile/Tabs';

export default function Page({ params }: { params: Promise<{ username: string }> }) {
  const { username } = use(params);
  const u = decodeURIComponent(username);
  return <ProfileFrame key={u} username={u} tab="info">{(ctx) => <InfoTab ctx={ctx} />}</ProfileFrame>;
}
