'use client';
// Actions for one message (long-press on phones, right-click or the ⋯ button elsewhere): react, reply,
// copy, edit (mine: re-sealed, shown as "edited", no history kept), unsend (mine: wiped for everyone, files
// too, live on the other screens) and report (others'). A report includes the message only while the reporter
// leaves "Include the message" on: then the decrypted message, its own content key and its franking evidence
// (lib/chat/franking.ts, so Kithwall can confirm who sent it) go to moderators, nothing else from the chat.
// No time limits: people control their own words.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT, type MessageKey } from '@/i18n';
import { deleteMessage, editMessage, MAX_MESSAGE_CHARS, messageContentKey, type ChatPayload, type ConversationSummary } from '@/lib/messages';
import { REACTIONS, setReaction, type ReactionEmoji } from '@/lib/chat/reactions';
import { reportItem, type ReportReason } from '@/lib/report';
import { frankEvidence, withoutFk } from '@/lib/chat/franking';
import type { MessageRow } from '@/lib/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { List, ListItem } from '@/components/ui/ListItem';
import { Textarea } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui/cx';
import { attachmentObjects } from './send';
import { useNameOf } from './look';

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
  const [step, setStep] = useState<'menu' | 'unsend' | 'report' | 'edit'>('menu');
  const [draft, setDraft] = useState(line.payload?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [include, setInclude] = useState(true);
  const nameOf = useNameOf();
  const p = line.payload;
  // Evidence exists only when this device checked the message's commitment (readMessage) and it matched.
  const evidence = p ? frankEvidence(line.row, p) : null;

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

  async function saveEdit() {
    const next = draft.trim();
    if (!p || next === (p.text ?? '').trim()) { onClose(); return; }
    if (!next && !p.attachments?.length) return;
    setBusy(true);
    try {
      await editMessage(c, line.row, next);
      await qc.invalidateQueries({ queryKey: ['messages', c.id] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      onClose();
      toast({ message: t('edit.saved') });
    } catch { setBusy(false); toast({ message: t('edit.failed'), tone: 'danger' }); }
  }

  async function report() {
    if (!reason) return;
    setBusy(true);
    try {
      await reportItem({
        kind: 'message', id: line.id, reason, details: details.trim() || undefined,
        // With evidence, the committed body already holds the message: it isn't sent twice.
        disclosure: p && include
          ? { plaintext: evidence ? null : withoutFk(p), contentKey: messageContentKey(c, line.row), keyKind: 'content', frank: evidence }
          : undefined,
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

  if (step === 'edit') {
    const empty = !draft.trim() && !p?.attachments?.length;
    return (
      <Dialog open onClose={onClose} title={t('edit.messageTitle')} sheet dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('menu')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="primary" busy={busy} disabled={empty} onClick={() => void saveEdit()}>{t('edit.save')}</Button></>}>
        <div className="k-stack">
          <Textarea label={t('edit.messageTitle')} hideLabel value={draft} rows={4} maxLength={MAX_MESSAGE_CHARS} dir="auto" autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveEdit(); } }} />
          <p className="k-small k-muted">{t('edit.note')}</p>
        </div>
      </Dialog>
    );
  }

  if (step === 'report') {
    return (
      <Dialog open onClose={onClose} title={t('messages.report.title')} sheet dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('menu')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="danger" busy={busy} disabled={!reason} onClick={() => void report()}>{t('messages.report.send')}</Button></>}>
        <div className="k-stack">
          {p ? (
            <Switch checked={include} onChange={setInclude} label={t('messages.report.include')}
              description={include ? t('messages.report.disclosure') : t('messages.report.withoutMessage')} />
          ) : null}
          {!p ? <Callout>{t('messages.report.cantInclude')}</Callout>
            : include ? <Callout tone={evidence ? 'success' : 'warning'}>{evidence ? t('messages.report.proof', { name: nameOf(line.row.sender_id) }) : t('messages.report.noProof')}</Callout>
            : null}
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
          {mine && p && !p.event ? <li><ListItem icon="edit" title={t('edit.message')} onClick={() => { setDraft(p.text ?? ''); setStep('edit'); }} chevron={false} /></li> : null}
          {mine ? <li><ListItem icon="close" title={t('messages.actions.unsend')} subtitle={t('messages.actions.unsendSub')} onClick={() => setStep('unsend')} chevron={false} /></li> : null}
          {!mine && !p?.event ? <li><ListItem icon="alert" title={t('messages.report.title')} onClick={() => setStep('report')} chevron={false} /></li> : null}
        </List>
      </div>
    </Dialog>
  );
}
