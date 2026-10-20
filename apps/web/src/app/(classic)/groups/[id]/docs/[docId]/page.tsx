'use client';
import { use } from 'react';
import { GroupView } from '@/components/groups/GroupView';

export default function GroupDocPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = use(params);
  return <GroupView id={id} tab="docs" docId={docId} />;
}
