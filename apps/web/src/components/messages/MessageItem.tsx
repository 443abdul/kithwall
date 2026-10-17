'use client';
// One message in a thread (Nov 2010 Messages layout: 50px avatar, name, time, text).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { ReportDialog } from '@/components/ReportDialog';
import { Icon } from '@/components/Icon';
import { keyring } from '@/lib/keys/keyring';
import { useSession } from '@/lib/keys/session';
import { people, usePerson } from '@/lib/people';
import { clock, when } from '@/lib/format';
import { deleteMessage, messageContentKey, readMessage, type ChatPayload, type ConversationSummary } from '@/lib/messages';
import type { Decrypted } from '@/lib/content';
import type { MessageRow } from '@/lib/types';
import { MessageText } from './MessageText';
import { Attachment } from './Attachment';
import { Confirm } from './Dialog';

export function eventText(p: ChatPayload, nameOf: (id: string) => string): string | null {
  const e = p.event;
  if (!e) return null;
  const list = (ids: string[]) => {
    const n = ids.map(nameOf);
    return n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
  };
  switch (e.kind) {
    case 'rename': return e.name ? `named the conversation "${e.name}".` : 'removed the conversation name.';
    case 'added': return `added ${list(Array.isArray(e.ids) ? e.ids : [])} to the conversation.`;
    case 'removed': return `removed ${list(Array.isArray(e.ids) ? e.ids : [])} from the conversation.`;
    case 'left': return 'left the conversation.';
    default: return null;
  }
}

export const nameOf = (id: string) => people.person(id)?.name ?? 'Someone';

/** The "waiting for key" / "couldn't be verified" placeholders (dev-guide rule 5). */
export function Undecryptable({ d, senderId, beforeJoin }: { d: Decrypted<unknown>; senderId: string; beforeJoin?: boolean }) {
  const p = usePerson(senderId);
  if (d.ok) return null;
  if (d.reason === 'unverified') return <div className="kwm-state"><Icon name="shield" /> This item couldn&rsquo;t be verified.</div>;
  if (beforeJoin) return <div className="kwm-state"><Icon name="lock" /> Sent before you were added to this conversation.</div>;
  return <div className="kwm-state"><Icon name="lock" /> Waiting for {p?.name ?? 'the sender'}&rsquo;s device to share this with you.</div>;
}

export function MessageItem({ conv, row }: { conv: ConversationSummary; row: MessageRow }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [report, setReport] = useState(false);
  const d = readMessage(conv, row);
  const mine = row.sender_id === userId;
  const beforeJoin = !d.ok && d.reason === 'waiting' && !!conv.joinedAt && row.created_at < conv.joinedAt;

  if (d.ok && d.value.event) {
    const t = eventText(d.value, nameOf);
    if (t) return <div className="kwm-ev"><NameLink id={row.sender_id} /> {t} <span className="gray">{clock(new Date(row.created_at))}</span></div>;
  }

  return (
    <div className="msgi kwm-msg" id={`m-${row.id}`}>
      <AvatarLink id={row.sender_id} size={50} />
      <div className="kwm-body">
        <div className="kwm-head">
          <NameLink id={row.sender_id} />
          <span className="gray" title={new Date(row.created_at).toLocaleString()}>{when(row.created_at)}</span>
        </div>
        {d.ok ? (
          <>
            {d.value.text ? <div className="kwm-tx"><MessageText text={d.value.text} /></div> : null}
            {d.value.attachments?.length ? (
              <div className="kwm-atts">{d.value.attachments.slice(0, 6).map((a) => <Attachment key={a.path} file={a} />)}</div>
            ) : null}
          </>
        ) : <Undecryptable d={d} senderId={row.sender_id} beforeJoin={beforeJoin} />}
        <div className="kwm-acts">
          {mine
            ? <button type="button" className="kwm-link" onClick={() => setConfirm(true)}>Delete</button>
            : d.ok ? <button type="button" className="kwm-link" onClick={() => setReport(true)}>Report</button> : null}
        </div>
      </div>
      {confirm && (
        <Confirm title="Delete Message" confirm="Delete" onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await deleteMessage(row, d.ok ? d.value.attachments ?? [] : []);
            await qc.invalidateQueries({ queryKey: ['messages', conv.id] });
            await qc.invalidateQueries({ queryKey: ['conversations'] });
          }}>
          Delete this message for everyone in the conversation? This can&rsquo;t be undone.
        </Confirm>
      )}
      {report && d.ok && (
        <ReportDialog kind="message" id={row.id} onClose={() => setReport(false)}
          disclosure={{ plaintext: d.value, contentKey: messageContentKey(conv, row), keyKind: 'content' }} />
      )}
    </div>
  );
}
