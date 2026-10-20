'use client';
import { use } from 'react';
import { GroupView } from '@/components/groups/GroupView';

export default function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <GroupView id={id} tab="wall" />;
}
