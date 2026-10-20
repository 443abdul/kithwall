'use client';
// How a conversation looks in Kithwall 2: its title (decrypted name, the other person's name, or the
// circle's name) and its picture (person avatar, two stacked avatars, or the circle's mark).
import { useQuery } from '@tanstack/react-query';
import { useFormat, useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import { useKeyringVersion } from '@/lib/hooks';
import { getGroup, readGroup } from '@/lib/groups';
import { readName, type ConversationSummary } from '@/lib/messages';
import { Avatar } from '@/components/ui/Avatar';

export function PersonAvatar({ id, size = 40 }: { id: string | null | undefined; size?: number }) {
  const p = usePerson(id);
  const url = useFileUrl(p?.info?.avatar?.thumb);
  return <Avatar name={p?.name ?? ''} src={url} size={size} />;
}

export function useNameOf(): (id: string) => string {
  usePeopleVersion();
  const t = useT();
  return (id: string) => people.person(id)?.name ?? t('messages.someone');
}

/** A circle's decrypted name and emoji (for circle chats). */
export function useCircleLook(circleId: string | null | undefined) {
  const { status } = useSession();
  useKeyringVersion();
  const q = useQuery({
    queryKey: ['circle-look', circleId], enabled: status === 'ready' && !!circleId, staleTime: 5 * 60_000,
    queryFn: () => getGroup(circleId!),
  });
  const g = q.data ?? null;
  const d = g ? readGroup(g) : null;
  const info = d?.ok ? (d.value as { name: string; emoji?: string }) : null;
  return { name: info?.name ?? null, emoji: typeof info?.emoji === 'string' ? info.emoji : null, loading: q.isLoading };
}

export function useConversationTitle(c: ConversationSummary | null | undefined): string {
  const t = useT();
  const f = useFormat();
  const { userId } = useSession();
  const nameOf = useNameOf();
  useKeyringVersion();
  const circle = useCircleLook(c?.kind === 'group' ? c.circleId : null);
  if (!c) return '';
  if (c.kind === 'group') return circle.name ?? t('messages.circleChat');
  const n = readName(c);
  if (n.ok && n.value) return n.value;
  const others = c.members.filter((m) => m !== userId);
  if (!others.length) return t('messages.onlyYou');
  const names = others.map(nameOf);
  if (names.length <= 3) return f.list(names);
  return t('messages.namesAndOthers', { names: names.slice(0, 2).join(', '), count: names.length - 2 });
}

/** Round picture for a conversation row / header. */
export function ConversationAvatar({ c, size = 48 }: { c: ConversationSummary; size?: number }) {
  const { userId } = useSession();
  const circle = useCircleLook(c.kind === 'group' ? c.circleId : null);
  if (c.kind === 'group') {
    return (
      <span className="k-chat-circlemark" style={{ ['--av' as string]: `${size}px` }} aria-hidden>
        {circle.emoji || (circle.name ? Array.from(circle.name)[0]?.toLocaleUpperCase() : '◎')}
      </span>
    );
  }
  const others = c.members.filter((m) => m !== userId);
  if (c.isDm || others.length <= 1) return <PersonAvatar id={others[0] ?? userId} size={size} />;
  const small = Math.round(size * 0.68);
  return (
    <span className="k-chat-avstack" style={{ ['--av' as string]: `${size}px` }} aria-hidden>
      <PersonAvatar id={others[0]} size={small} />
      <PersonAvatar id={others[1]} size={small} />
    </span>
  );
}
