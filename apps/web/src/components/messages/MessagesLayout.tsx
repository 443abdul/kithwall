'use client';
// Messages frame (Kithwall 2). Phones: the list, or one chat full-screen (the shell's bars step aside,
// swipe from the starting edge goes back). ≥ 768 px: the list and the open chat side by side.
import { useParams, useSelectedLayoutSegment } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { useSettings, loadSettings } from '@/lib/settings';
import { useSession } from '@/lib/keys/session';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { ConversationListPane } from './ChatList';
import { useChatRuntime } from './runtime';

export function MessagesLayout({ children }: { children: ReactNode }) {
  const t = useT();
  const segment = useSelectedLayoutSegment();
  const params = useParams<{ id?: string }>();
  const { status } = useSession();
  const s = useSettings();
  useDocumentTitle(t('nav.messages'));
  useEffect(() => { if (status === 'ready') void loadSettings().catch(() => undefined); }, [status]);
  useChatRuntime(s.typingIndicator);
  const open = segment !== null;
  const activeId = typeof params?.id === 'string' ? params.id.toLowerCase() : null;
  return (
    <div className="k-msgs" data-open={open ? '' : undefined}>
      <main id="main" className="k-msgs-main" tabIndex={-1}>
        <section className="k-msgs-list" aria-label={t('messages.listLabel')}>
          <ConversationListPane activeId={activeId} />
        </section>
        <section className="k-msgs-detail">{children}</section>
      </main>
    </div>
  );
}
