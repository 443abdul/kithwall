'use client';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';

/** Me plus my friends (null while loading) — the authors whose notes/questions/check-ins I see. */
export function useAuthors(): string[] | null {
  const { userId } = useSession();
  const friends = useFriendIds();
  if (!userId || !friends.data) return null;
  return [userId, ...friends.data];
}
