'use client';
// New chat (Kithwall 2): pick one connection for a 1:1 chat, or several for a group (optional name).
// /messages/new?to=<user id> opens (or creates) the 1:1 chat straight away (used by profiles).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { createConversation, NotConnectedError, openDm } from '@/lib/messages';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { Icon } from '@/components/ui/Icon';
import { PeoplePicker } from './PeoplePicker';
import { useNameOf } from './look';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GROUP = 49;

export function NewChat({ to }: { to?: string }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { status, userId } = useSession();
  const nameOf = useNameOf();
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // 'connect': someone picked isn't a connection (chats are only with connections, security review D2).
  const [err, setErr] = useState<false | 'failed' | 'connect'>(false);
  const direct = !!to && UUID.test(to) && to.toLowerCase() !== userId;
  const started = useRef(false);

  useEffect(() => {
    if (!direct || status !== 'ready' || started.current) return;
    started.current = true;
    openDm(to!.toLowerCase())
      .then((c) => { void qc.invalidateQueries({ queryKey: ['conversations'] }); router.replace(`/messages/${c.id}`); })
      .catch((e) => setErr(e instanceof NotConnectedError ? 'connect' : 'failed'));
  }, [direct, status, to, qc, router]);

  async function start() {
    if (!picked.length) return;
    setBusy(true); setErr(false);
    try {
      const c = picked.length === 1 ? await openDm(picked[0]!) : await createConversation(picked, null, name.trim() || undefined);
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      router.replace(`/messages/${c.id}`);
    } catch (e) { setErr(e instanceof NotConnectedError ? 'connect' : 'failed'); setBusy(false); }
  }

  if (direct && !err) return <div className="k-chat-thread k-chat-center"><Spinner size={28} label={t('messages.new.opening')} /></div>;

  return (
    <div className="k-chat-thread k-chat-new">
      <header className="k-chat-head">
        <Link href="/messages" className="k-iconbtn k-chat-back" aria-label={t('messages.backToList')} title={t('messages.backToList')}><Icon name="back" /></Link>
        <h2 className="k-chat-new-title">{t('messages.newChat')}</h2>
      </header>
      <div className="k-chat-new-body">
        {err ? <Callout tone="danger">{t(err === 'connect' ? 'security.chatNeedsConnection' : 'messages.new.failed')}</Callout> : null}
        {picked.length ? (
          <ul className="k-chat-selected" aria-label={t('messages.new.selected')}>
            {picked.map((id) => (
              <li key={id}>
                <button type="button" className="k-chat-tag" onClick={() => setPicked((p) => p.filter((x) => x !== id))} aria-label={t('messages.new.unselect', { name: nameOf(id) })}>
                  {nameOf(id)} <span aria-hidden>×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="k-small k-muted">{t('messages.new.hint')}</p>}
        {picked.length > 1 ? (
          <TextField label={t('messages.new.groupName')} hint={t('messages.new.groupNameHint')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        ) : null}
        <PeoplePicker selected={picked} max={MAX_GROUP} onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} />
      </div>
      <div className="k-chat-new-foot">
        <Button variant="primary" block busy={busy} disabled={!picked.length} onClick={() => void start()} icon="messages">
          {picked.length > 1 ? t('messages.new.startGroup', { count: picked.length + 1 }) : t('messages.new.start')}
        </Button>
      </div>
    </div>
  );
}
