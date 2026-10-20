'use client';
// Shown beside the list on wide screens when no chat is open.
import { useT } from '@/i18n';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';

export function ChatPlaceholder() {
  const t = useT();
  return (
    <div className="k-chat-thread k-chat-center k-chat-placeholder">
      <EmptyState icon="sealed" title={t('messages.pickTitle')} body={t('messages.pickBody')}
        actions={<ButtonLink href="/messages/new" variant="soft" icon="plus">{t('messages.newChat')}</ButtonLink>} />
    </div>
  );
}
