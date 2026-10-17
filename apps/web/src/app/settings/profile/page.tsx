'use client';
import { Suspense } from 'react';
import { AppPage } from '@/components/Shell';
import { EditProfile } from '@/components/profile/EditProfile';

export default function Page() {
  return <AppPage wide><Suspense fallback={<div className="gray">Loading…</div>}><EditProfile /></Suspense></AppPage>;
}
