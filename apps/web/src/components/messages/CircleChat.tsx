'use client';
// /messages/circle/[circleId]: open the circle's chat (created on first use; see lib/chat/circle.ts).
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { NotInCircleError, openCircleChat } from '@/lib/chat/circle';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';

export function CircleChat({ circleId }: { circleId: string }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useSession();
  const [failed, setFailed] = useState<'not_member' | 'error' | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (status !== 'ready' || started.current) return;
    started.current = true;
    openCircleChat(circleId)
      .then((c) => { void qc.invalidateQueries({ queryKey: ['conversations'] }); router.replace(`/messages/${c.id}`); })
      .catch((e) => setFailed(e instanceof NotInCircleError ? 'not_member' : 'error'));
  }, [status, circleId, qc, router]);
  if (!failed) return <div className="k-chat-thread k-chat-center"><Spinner size={28} label={t('messages.circle.opening')} /></div>;
  return (
    <div className="k-chat-thread k-chat-center">
      <EmptyState icon="circles" title={failed === 'not_member' ? t('messages.circle.notMember') : t('messages.circle.failed')}
        body={failed === 'not_member' ? t('messages.circle.notMemberBody') : undefined}
        actions={<ButtonLink href="/circles" variant="secondary">{t('messages.circle.toCircles')}</ButtonLink>} />
    </div>
  );
}
