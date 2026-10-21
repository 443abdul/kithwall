'use client';
// Disappearing messages in a chat (phase 3): the timer picker (chat details), the header hint, and the
// gentle one-time suggestion in chats from before disappearing messages existed (their timer is "off"
// because the migration never deletes history; new chats start at 4 weeks).
import { useState } from 'react';
import { isHiddenChat } from '@/lib/safety/hidden';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { setConversationTimer, type ConversationSummary } from '@/lib/messages';
import { DEFAULT_MESSAGE_TIMER, durationKey, MESSAGE_TIMERS, type MessageTimer } from '@/lib/chat/ephemeral';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';

/** Any member of a 1:1 chat; admins of group and circle chats (the database enforces the same rule). */
export function useCanSetTimer(c: ConversationSummary): boolean {
  const { userId } = useSession();
  if (!userId || !c.members.includes(userId)) return false;
  return c.isDm || c.admins.includes(userId);
}

/** Change the timer, refresh, and say so. Returns false on failure (after a toast). */
export function useSetTimer(c: ConversationSummary) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  return async (secs: MessageTimer): Promise<boolean> => {
    try {
      await setConversationTimer(c, secs);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['conversations'] }),
        qc.invalidateQueries({ queryKey: ['messages', c.id] }),
      ]);
      toast({ message: secs ? t('ephemeral.chat.changed', { duration: t(durationKey(secs)) }) : t('ephemeral.chat.changedOff') });
      return true;
    } catch {
      toast({ message: t('ephemeral.chat.failed'), tone: 'danger' });
      return false;
    }
  };
}

/** Radio list of the chat timers. */
export function TimerOptions({ value, disabled, onPick }: { value: number | null; disabled?: boolean; onPick: (v: MessageTimer) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t('ephemeral.chat.title')} className="k-eph-options">
      {MESSAGE_TIMERS.map((v) => {
        const on = (value ?? null) === v;
        return (
          <label key={String(v)} className={cx('k-eph-option', on && 'is-on', disabled && 'is-disabled')}>
            <input type="radio" name="k-eph-timer" value={String(v)} checked={on} disabled={disabled} onChange={() => onPick(v)} />
            <span>{t(durationKey(v))}</span>
            {v === DEFAULT_MESSAGE_TIMER ? <span className="k-eph-default">{t('ephemeral.chat.recommended')}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

/** The timer step of the chat details sheet. */
export function TimerPanel({ c }: { c: ConversationSummary }) {
  const t = useT();
  const can = useCanSetTimer(c);
  const set = useSetTimer(c);
  const [busy, setBusy] = useState(false);
  const value = c.disappear_secs ?? null;
  return (
    <div className="k-stack">
      <p className="k-eph-explain"><Icon name="clock" /> <span>{t('ephemeral.chat.explain')}</span></p>
      <TimerOptions value={value} disabled={!can || busy} onPick={(v) => {
        if (v === value) return;
        setBusy(true);
        void set(v).finally(() => setBusy(false));
      }} />
      {!can ? <p className="k-small k-muted">{t('ephemeral.chat.adminsOnly')}</p> : null}
    </div>
  );
}

/** "Disappearing · 4 weeks" in the chat header (nothing when off). */
export function TimerHint({ secs }: { secs: number | null | undefined }) {
  const t = useT();
  if (!secs) return null;
  return <span className="k-eph-hint"><Icon name="clock" /> {t(durationKey(secs))}</span>;
}

const DISMISS_KEY = 'kw.eph.suggest.';
const dismissedInMemory = new Set<string>();
function dismissed(convId: string): boolean {
  if (dismissedInMemory.has(convId)) return true;
  try { return localStorage.getItem(DISMISS_KEY + convId) === '1'; } catch { return false; }
}
function dismiss(convId: string) {
  dismissedInMemory.add(convId);
  // A hidden chat's id never goes into plaintext storage (security review L10).
  if (isHiddenChat(convId)) return;
  try { localStorage.setItem(DISMISS_KEY + convId, '1'); } catch { /* private mode: it just shows again */ }
}

/**
 * One-time suggestion in chats that predate disappearing messages (timer off and never chosen). Shown to
 * whoever may change the timer; "Keep everything" hides it for good on this device.
 */
export function OldChatSuggestion({ c, onChoose }: { c: ConversationSummary; onChoose: () => void }) {
  const t = useT();
  const can = useCanSetTimer(c);
  const set = useSetTimer(c);
  const [hidden, setHidden] = useState(() => dismissed(c.id));
  const [busy, setBusy] = useState(false);
  if (hidden || !can || c.disappear_secs || c.disappear_set_at) return null;
  return (
    <aside className="k-eph-suggest" aria-labelledby={`eph-s-${c.id}`}>
      <span className="k-eph-suggest-ico" aria-hidden><Icon name="clock" /></span>
      <div className="k-eph-suggest-body">
        <p id={`eph-s-${c.id}`} className="k-eph-suggest-title">{t('ephemeral.suggest.title')}</p>
        <p className="k-small k-muted">{t('ephemeral.suggest.body')}</p>
        <div className="k-eph-suggest-actions">
          <Button size="sm" variant="primary" busy={busy} onClick={() => {
            setBusy(true);
            void set(DEFAULT_MESSAGE_TIMER).then((ok) => { if (ok) { dismiss(c.id); setHidden(true); } }).finally(() => setBusy(false));
          }}>{t('ephemeral.suggest.on')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onChoose}>{t('ephemeral.suggest.choose')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { dismiss(c.id); setHidden(true); }}>{t('ephemeral.suggest.dismiss')}</Button>
        </div>
      </div>
    </aside>
  );
}
