'use client';
// STUB: replaced by the feed & people work stream.
import { EmptyState } from '@/components/ui';
import type { FeedProps } from '.';

export function Feed({ empty }: FeedProps) {
  return <>{empty ?? <EmptyState title="No posts yet" />}</>;
}
