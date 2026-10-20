'use client';
// Chat details (Kithwall 2): members, rename, add people, pin, archive, leave; circle chats link to the
// circle (their membership is the circle's). Phase 3: disappearing messages, and "Verify safety number"
// for 1:1 chats (the safety-number screen lives at /u/<handle>/verify).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { addMembers, leaveConversation, removeMember, renameConversation, type ConversationSummary } from '@/lib/messages';
import { isPinned, useMessagesPrefs, useSetArchived, useSetPinned } from '@/lib/chat/prefs';
import { durationKey } from '@/lib/chat/ephemeral';
import { usePerson } from '@/lib/people';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { List, ListItem } from '@/components/ui/ListItem';
import { TextField } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { ConversationAvatar, PersonAvatar, useNameOf } from './look';
import { PeoplePicker } from './PeoplePicker';
import { ChatIcon } from './ChatIcon';
import { TimerPanel } from './Ephemeral';

type Step = 'main' | 'add' | 'rename' | 'leave' | 'timer';

export function ChatInfo({ c, open, onClose, title, initialStep = 'main' }: {
  c: ConversationSummary; open: boolean; onClose: () => void; title: string; initialStep?: 'main' | 'timer';
}) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { userId } = useSession();
  const nameOf = useNameOf();
  const prefs = useMessagesPrefs();
  const setPinned = useSetPinned();
  const setArchived = useSetArchived();
  const [step, setStep] = useState<Step>(initialStep);
  // Re-opened from the header or the old-chat suggestion: start where the caller asked.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) { setWasOpen(open); if (open) setStep(initialStep); }
  const other = c.isDm ? c.members.find((m) => m !== userId) ?? null : null;
  const otherPerson = usePerson(other);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const isChat = c.kind === 'conversation';
  const isGroupChat = isChat && !c.isDm;
  const amAdmin = !!userId && c.admins.includes(userId);
  const amOwner = c.ownerId === userId;
  const pinned = isPinned(prefs.data, c.id);

  const close = () => { setStep('main'); setPicked([]); onClose(); };
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['conversations'] });
    await qc.invalidateQueries({ queryKey: ['messages', c.id] });
  };
  async function run(fn: () => Promise<void>, ok?: string) {
    setBusy(true);
    try { await fn(); await refresh(); if (ok) toast({ message: ok }); setStep('main'); }
    catch { toast({ message: t('messages.info.failed'), tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (step === 'add') {
    return (
      <Dialog open={open} onClose={close} title={t('messages.info.addPeople')} sheet dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('main')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="primary" busy={busy} disabled={!picked.length} onClick={() => void run(() => addMembers(c, picked), t('messages.info.added'))}>{t('messages.info.add', { count: picked.length })}</Button></>}>
        <p className="k-small k-muted">{t('messages.info.addNote')}</p>
        <PeoplePicker selected={picked} exclude={c.members} onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} />
      </Dialog>
    );
  }
  if (step === 'rename') {
    return (
      <Dialog open={open} onClose={close} title={t('messages.info.rename')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('main')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void run(() => renameConversation(c, name))}>{t('messages.info.save')}</Button></>}>
        <TextField label={t('messages.info.nameLabel')} hint={t('messages.info.nameHint')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Dialog>
    );
  }
  if (step === 'timer') {
    return (
      <Dialog open={open} onClose={close} title={t('ephemeral.chat.title')} sheet
        footer={<Button variant="ghost" onClick={() => (initialStep === 'timer' ? close() : setStep('main'))}>{initialStep === 'timer' ? t('common.done') : t('common.back')}</Button>}>
        <TimerPanel c={c} />
      </Dialog>
    );
  }
  if (step === 'leave') {
    return (
      <Dialog open={open} onClose={close} title={t('messages.info.leaveTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setStep('main')} disabled={busy}>{t('common.back')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void run(async () => { await leaveConversation(c); close(); router.push('/messages'); })}>{t('messages.info.leave')}</Button></>}>
        <p className="k-muted">{t('messages.info.leaveBody')}</p>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title={t('messages.info.title')} sheet>
      <div className="k-stack">
        <div className="k-chat-info-hero">
          <ConversationAvatar c={c} size={72} />
          <p className="k-chat-info-title">{title}</p>
          <p className="k-small k-muted"><Icon name="lock" /> {t('messages.info.sealed')}</p>
        </div>
        <List>
          <li><ListItem leading={<ChatIcon name="pin" />} title={pinned ? t('messages.info.unpin') : t('messages.info.pin')} chevron={false}
            onClick={() => void run(() => setPinned(c.id, !pinned), pinned ? t('messages.info.unpinned') : t('messages.info.pinned'))} /></li>
          <li><ListItem leading={<ChatIcon name="archive" />} title={t('messages.info.archive')} subtitle={t('messages.info.archiveSub')} chevron={false}
            onClick={() => void run(async () => { await setArchived(c.id, true); close(); router.push('/messages'); }, t('messages.info.archived'))} /></li>
          <li><ListItem icon="clock" title={t('ephemeral.chat.title')} chevron
            subtitle={c.disappear_secs ? t('ephemeral.chat.sub', { duration: t(durationKey(c.disappear_secs)) }) : t('ephemeral.chat.subOff')}
            onClick={() => setStep('timer')} /></li>
          {c.isDm && otherPerson?.username ? (
            <li><ListItem icon="shield" title={t('messages.info.verifySafety')} subtitle={t('messages.info.verifySafetySub', { name: otherPerson.name })}
              href={`/u/${otherPerson.username}/verify`} /></li>
          ) : null}
          {c.kind === 'group' && c.circleId ? <li><ListItem icon="circles" title={t('messages.info.openCircle')} subtitle={t('messages.info.circleNote')} href={`/circles/${c.circleId}`} /></li> : null}
          {isGroupChat && amAdmin ? <li><ListItem icon="edit" title={t('messages.info.rename')} onClick={() => { setName(''); setStep('rename'); }} chevron={false} /></li> : null}
          {isGroupChat ? <li><ListItem icon="plus" title={t('messages.info.addPeople')} onClick={() => { setPicked([]); setStep('add'); }} chevron={false} /></li> : null}
        </List>
        <h3 className="k-section-title">{t('messages.members', { count: c.members.length })}</h3>
        <ul className="k-chat-members">
          {c.members.map((m) => (
            <li key={m}>
              <PersonAvatar id={m} size={36} />
              <span className="k-chat-members-name">{m === userId ? t('messages.you') : nameOf(m)}</span>
              {c.admins.includes(m) && !c.isDm ? <Badge tone="neutral">{t('messages.info.admin')}</Badge> : null}
              {isGroupChat && amOwner && m !== userId ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => removeMember(c, m), t('messages.info.removed'))}>{t('messages.info.remove')}</Button>
              ) : null}
            </li>
          ))}
        </ul>
        {isGroupChat ? <Button variant="secondary" icon="logout" onClick={() => setStep('leave')}>{t('messages.info.leave')}</Button> : null}
        {c.kind === 'group' && c.circleId ? <p className="k-small k-muted">{t('messages.info.circleLeave')} <Link href={`/circles/${c.circleId}`}>{t('messages.info.openCircle')}</Link></p> : null}
      </div>
    </Dialog>
  );
}
