'use client';
import { use } from 'react';
import { PageView } from '@/components/pages/PageView';

export default function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PageView id={id} />;
}
