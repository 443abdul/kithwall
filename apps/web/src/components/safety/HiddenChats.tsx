'use client';
// Safety centre → Hidden chats: choose chats to hide behind the app PIN, reveal or conceal them.
import { useState } from 'react';
import { useT } from '@/i18n';
import { useConversations } from '@/lib/hooks';
import type { ConversationSummary } from '@/lib/messages';
import { useAppLock } from '@/lib/safety/applock';
import { concealHiddenChats, hideChat, unhideChat, useHiddenChatIds, useRevealed } from '@/lib/safety/hidden';
import { ConversationAvatar, useConversationTitle } from '@/components/messages/look';
import { Section } from '@/components/settings/shared';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { SafetyPage } from './SafetyCentre';
import { RevealHiddenDialog } from './PinDialog';

function ChatRow({ c, hidden, onToggle, busy }: { c: ConversationSummary; hidden: boolean; onToggle: () => void; busy: boolean }) {
  const t = useT();
  const title = useConversationTitle(c);
  return (
    <li>
      <ConversationAvatar c={c} size={40} />
      <span className="k-set-item-body">
        <span className="k-set-item-title">{title} {hidden ? <Badge tone="neutral">{t('safety.hidden.badge')}</Badge> : null}</span>
      </span>
      <Button size="sm" variant={hidden ? 'secondary' : 'ghost'} icon={hidden ? 'eye' : 'eyeOff'} disabled={busy} onClick={onToggle}>
        {hidden ? t('safety.hidden.unhide') : t('safety.hidden.hide')}
      </Button>
    </li>
  );
}

export function HiddenChats() {
  const t = useT();
  const toast = useToast();
  const { pin } = useAppLock();
  const ids = useHiddenChatIds();
  const revealed = useRevealed();
  const convs = useConversations();
  const [revealing, setRevealing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(c: ConversationSummary) {
    setBusy(c.id);
    try {
      if (ids.has(c.id)) { await unhideChat(c.id); toast({ message: t('safety.hidden.unhidden') }); }
      else { await hideChat(c.id); toast({ message: t('safety.hidden.hidden') }); }
    } catch { toast({ message: t('errors.unknown'), tone: 'danger' }); } finally { setBusy(null); }
  }

  const list = (convs.data ?? []).filter((c) => revealed || !ids.has(c.id));

  return (
    <SafetyPage title={t('safety.hidden.title')} description={t('safety.hidden.pageBody')}>
      {pin !== 'set' ? (
        <Callout tone="info">
          <span>{t('safety.hidden.needsPin')} </span>
          <ButtonLink href="/you/safety/lock" size="sm" variant="soft">{t('safety.hidden.setPin')}</ButtonLink>
        </Callout>
      ) : (
        <Section id="hidden-state" title={revealed ? t('safety.hidden.revealedTitle') : t('safety.hidden.concealedTitle')}
          description={revealed ? t('safety.hidden.revealedBody') : t('safety.hidden.concealedBody', { count: ids.size })}>
          <div className="k-row-wrap">
            {revealed
              ? <Button variant="secondary" icon="eyeOff" onClick={concealHiddenChats}>{t('safety.hidden.conceal')}</Button>
              : <Button variant="primary" icon="eye" onClick={() => setRevealing(true)}>{t('safety.hidden.reveal')}</Button>}
          </div>
        </Section>
      )}
      <Section id="hidden-list" title={t('safety.hidden.choose')} description={t('safety.hidden.chooseBody')}>
        {convs.isLoading ? <Skeleton height={56} /> : null}
        {convs.data && !list.length ? <p className="k-muted k-small">{t('safety.hidden.noChats')}</p> : null}
        {list.length ? (
          <ul className="k-set-items">
            {list.map((c) => <ChatRow key={c.id} c={c} hidden={ids.has(c.id)} busy={busy === c.id || (pin !== 'set' && !ids.has(c.id))} onToggle={() => void toggle(c)} />)}
          </ul>
        ) : null}
      </Section>
      <Callout tone="info" icon="info">{t('safety.hidden.limits')}</Callout>
      <RevealHiddenDialog open={revealing} onClose={() => setRevealing(false)} />
    </SafetyPage>
  );
}
