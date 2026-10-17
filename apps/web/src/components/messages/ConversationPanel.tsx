'use client';
// Right-column box for a conversation: people (with online dots), Add People, Rename, Archive,
// Leave (groups), Remove (owner). Every action goes through lib/messages.ts.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { RightBox } from '@/components/Shell';
import { useSession } from '@/lib/keys/session';
import {
  addMembers, conversationTitle, createConversation, leaveConversation, readName, removeMember, renameConversation, type ConversationSummary,
} from '@/lib/messages';
import { isArchived, useMessagesPrefs, useSetArchived } from '@/lib/chat/prefs';
import { signals, useSignalsVersion } from '@/lib/chat/signals';
import { dock } from '@/lib/chat/dock';
import { useFriendIds } from '@/lib/hooks';
import { Confirm, Dialog } from './Dialog';
import { RecipientPicker } from './RecipientPicker';
import { nameOf } from './MessageItem';

type Modal = null | 'add' | 'rename' | 'leave' | { remove: string };

export function ConversationPanel({ conv }: { conv: ConversationSummary }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const prefs = useMessagesPrefs();
  const setArchived = useSetArchived();
  const friends = useFriendIds();
  useSignalsVersion();
  const [modal, setModal] = useState<Modal>(null);
  const [err, setErr] = useState<string | null>(null);
  const isOwner = conv.ownerId === userId;
  const isAdmin = !!userId && conv.admins.includes(userId);
  const archived = isArchived(prefs.data, conv.id, conv.last_message_at);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['conversations'] });
    await qc.invalidateQueries({ queryKey: ['messages', conv.id] });
  };

  return (
    <>
      <RightBox title={conv.isDm ? 'In This Conversation' : `People (${conv.members.length})`}>
        <ul className="kwm-people">
          {conv.members.map((m) => {
            const pres = m === userId ? null : signals.presenceOf(m);
            return (
              <li key={m}>
                <AvatarLink id={m} size={24} />
                <span className="kwm-pname"><NameLink id={m} bold={false} />{m === userId ? ' (you)' : ''}{m === conv.ownerId && !conv.isDm ? <span className="gray"> · owner</span> : null}</span>
                {pres && <span className={`dot${pres === 'idle' ? ' idle' : ''}`} title={pres === 'idle' ? 'Idle' : 'Online'} />}
                {isOwner && !conv.isDm && m !== userId && (
                  <button type="button" className="kwm-x" title="Remove from conversation" aria-label={`Remove ${nameOf(m)}`} onClick={() => setModal({ remove: m })}>&times;</button>
                )}
              </li>
            );
          })}
        </ul>
        {err && <div className="err" role="alert">{err}</div>}
        <ul className="kwm-opts">
          {conv.isDm && conv.members.length === 2 && userId && (
            <li><button type="button" className="kwm-link" onClick={() => dock.open({ convId: conv.id, userId: conv.members.find((m) => m !== userId) ?? null }, { focus: true })}>Open in Chat</button></li>
          )}
          <li><button type="button" className="kwm-link" onClick={() => setModal('add')}>Add People</button></li>
          {!conv.isDm && isAdmin && <li><button type="button" className="kwm-link" onClick={() => setModal('rename')}>Name Conversation</button></li>}
          <li><button type="button" className="kwm-link" onClick={async () => {
            setErr(null);
            try { await setArchived(conv.id, !archived); if (!archived) router.push('/messages'); } catch (e) { setErr((e as Error).message); }
          }}>{archived ? 'Unarchive' : 'Archive'}</button></li>
          {!conv.isDm && <li><button type="button" className="kwm-link" onClick={() => setModal('leave')}>Leave Conversation</button></li>}
        </ul>
      </RightBox>

      {modal === 'add' && (
        <AddPeople conv={conv} isOwner={isOwner} friendIds={friends.data ?? []} onClose={() => setModal(null)}
          onDone={async (newConvId) => { setModal(null); if (newConvId) router.push(`/messages/${newConvId}`); else await refresh(); }} />
      )}
      {modal === 'rename' && <Rename conv={conv} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'leave' && (
        <Confirm title="Leave Conversation" confirm="Leave Conversation" onClose={() => setModal(null)}
          onConfirm={async () => {
            await leaveConversation(conv);
            dock.closeConversation(conv.id);
            await qc.invalidateQueries({ queryKey: ['conversations'] });
            router.push('/messages');
          }}>
          You&rsquo;ll stop receiving messages from <b>{conversationTitle(conv, nameOf)}</b> and won&rsquo;t be able to read anything sent after you leave.
          {isOwner && conv.members.length > 2 ? ' Someone else in the conversation will take it over.' : ''}
        </Confirm>
      )}
      {modal && typeof modal === 'object' && (
        <Confirm title="Remove Person" confirm="Remove" onClose={() => setModal(null)}
          onConfirm={async () => { await removeMember(conv, modal.remove); await refresh(); }}>
          Remove <b>{nameOf(modal.remove)}</b> from this conversation? They&rsquo;ll keep what they&rsquo;ve already seen, but won&rsquo;t be able to read new messages.
        </Confirm>
      )}
    </>
  );
}

function AddPeople({ conv, isOwner, friendIds, onClose, onDone }: {
  conv: ConversationSummary; isOwner: boolean; friendIds: string[]; onClose: () => void; onDone: (newConvId?: string) => Promise<void> | void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!ids.length || busy) return;
    setBusy(true); setErr(null);
    try {
      if (!isOwner && ids.some((i) => !friendIds.includes(i))) throw new Error('You can only add your friends to this conversation.');
      if (conv.isDm) {
        // A one-to-one chat stays one-to-one: start a new group with everyone instead.
        const g = await createConversation([...conv.members, ...ids]);
        await onDone(g.id);
      } else {
        await addMembers(conv, ids);
        await onDone();
      }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Add People" onClose={onClose} busy={busy}
      buttons={<><button type="button" className={`btn b${busy ? ' dis' : ''}`} disabled={busy || !ids.length} onClick={() => void go()}>{busy ? 'Adding…' : 'Add People'}</button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button></>}>
      {conv.isDm && <p className="kwm-p">This starts a new group conversation with everyone.</p>}
      <RecipientPicker value={ids} onChange={setIds} exclude={conv.members} allowStrangers={isOwner || conv.isDm} autoFocus label="Add people" />
      {!conv.isDm && <p className="gray kwm-p">New people can read messages sent from now on.</p>}
      {err && <div className="err" role="alert">{err}</div>}
    </Dialog>
  );
}

function Rename({ conv, onClose, onDone }: { conv: ConversationSummary; onClose: () => void; onDone: () => Promise<void> }) {
  const current = readName(conv);
  const [name, setName] = useState(current.ok ? current.value : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await renameConversation(conv, name); await onDone(); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Name Conversation" onClose={onClose} busy={busy}
      buttons={<><button type="button" className={`btn b${busy ? ' dis' : ''}`} disabled={busy} onClick={() => void go()}>Save</button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <label className="kwm-lbl" htmlFor="kwm-name">Name</label>
        <input id="kwm-name" type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} />
        <p className="gray kwm-p">The name is encrypted &mdash; only people in the conversation can see it.</p>
      </form>
      {err && <div className="err" role="alert">{err}</div>}
    </Dialog>
  );
}
