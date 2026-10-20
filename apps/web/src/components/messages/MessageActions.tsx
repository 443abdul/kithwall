'use client';
// Actions for one message (long-press on phones, right-click or the ⋯ button elsewhere): react, reply,
// copy, unsend (mine: deleted for everyone, files too) and report (others': the decrypted message and
// its own content key go to moderators, nothing else from the chat).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT, type MessageKey } from '@/i18n';
import { deleteMessage, messageContentKey, type ChatPayload, type ConversationSummary } from '@/lib/messages';
import { REACTIONS, setReaction, type ReactionEmoji } from '@/lib/chat/reactions';
import { reportItem, type ReportReason } from '@/lib/report';
import type { MessageRow } from '@/lib/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { List, ListItem } from '@/components/ui/ListItem';
import { Textarea } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { attachmentObjects } from './send';

const REASONS: ReportReason[] = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'child_safety', 'self_harm', 'impersonation', 'illegal', 'other'];

export function MessageActions({ c, line, mine, myReaction, onReply, onClose }: {
  c: ConversationSummary;
  line: { id: string; row: MessageRow; payload: ChatPayload | null };
  mine: boolean;
  myReaction: string | null;
  onReply: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<'menu' | 'unsend' | 'report'>('menu');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const p = line.payload;

  async function react(e: ReactionEmoji) {
    onClose();
    try {
      await setReaction(c, line.id, myReaction === e ? null : e);
      await qc.invalidateQueries({ queryKey: ['reactions', c.id] });
    } catch { toast({ message: t('messages.reactions.failed'), tone: 'danger' }); }
  }

  async function copy() {
    onClose();
    try { await navigator.clipboard.writeText(p?.text ?? ''); toast({ message: t('messages.actions.copied') }); }
    catch { toast({ message: t('messages.actions.copyFailed'), tone: 'danger' }); }
  }

  async function unsend() {
    setBusy(true);
    try {
      await deleteMessage(line.row, attachmentObjects(p));
      await qc.invalidateQueries({ queryKey: ['messages', c.id] });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      onClose();
      toast({ message: t('messages.actions.unsent') });
    } catch { setBusy(false); toast({ message: t('messages.actions.unsendFailed'), tone: 'danger' }); }
  }

  async function report() {
    if (!reason || !p) return;
    setBusy(true);
    try {
      await reportItem({
        kind: 'message', id: line.id, reason, details: details.trim() || undefined,
        disclosure: { plaintext: p, contentKey: messageContentKey(c, line.row), keyKind: 'content' },
      });
      onClose();
      toast({ message: t('messages.report.sent') });
    } catch { setBusy(false); toast({ message: t('messages.report.failed'), tone: 'danger' }); }
  }

  if (step === 'unsend') {
    return (
      <Dialog open onClose={onClose} title={t('messages.actions.unsendTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('menu')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void unsend()}>{t('messages.actions.unsend')}</Button></>}>
        <p className="k-muted">{t('messages.actions.unsendBody')}</p>
      </Dialog>
    );
  }

  if (step === 'report') {
    return (
      <Dialog open onClose={onClose} title={t('messages.report.title')} sheet dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('menu')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="danger" busy={busy} disabled={!reason} onClick={() => void report()}>{t('messages.report.send')}</Button></>}>
        <div className="k-stack">
          <Callout>{t('messages.report.disclosure')}</Callout>
          <div role="radiogroup" aria-label={t('messages.report.reason')} className="k-chat-reasons">
            {REASONS.map((r) => (
              <label key={r} className={cx('k-chat-reason', reason === r && 'is-on')}>
                <input type="radio" name="k-report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                <span>{t(`messages.report.reason.${r}` as MessageKey)}</span>
              </label>
            ))}
          </div>
          <Textarea label={t('messages.report.details')} value={details} maxLength={2000} rows={3} onChange={(e) => setDetails(e.target.value)} />
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={t('messages.actions.title')} sheet>
      <div className="k-stack">
        {p ? (
          <div className="k-chat-react-row" role="group" aria-label={t('messages.reactions.pick')}>
            {REACTIONS.map((e) => (
              <button key={e} type="button" className={cx('k-chat-react-btn', myReaction === e && 'is-on')} aria-pressed={myReaction === e}
                aria-label={t('messages.reactions.react', { emoji: e })} onClick={() => void react(e)}>{e}</button>
            ))}
          </div>
        ) : null}
        <List>
          <li><ListItem icon="back" title={t('messages.actions.reply')} onClick={onReply} chevron={false} /></li>
          {p?.text ? <li><ListItem icon="copy" title={t('messages.actions.copy')} onClick={() => void copy()} chevron={false} /></li> : null}
          {mine ? <li><ListItem icon="close" title={t('messages.actions.unsend')} subtitle={t('messages.actions.unsendSub')} onClick={() => setStep('unsend')} chevron={false} /></li> : null}
          {!mine && p ? <li><ListItem icon="alert" title={t('messages.report.title')} onClick={() => setStep('report')} chevron={false} /></li> : null}
        </List>
      </div>
    </Dialog>
  );
}
