'use client';
// Bottom-right chat bar (2010): "Chat (n)" tab, buddy list of online friends, and up to three
// docked chat windows. Same conversations as Messages. Desktop only (hidden < 768 px by CSS).
// The dock re-mounts with every page; its state lives in lib/chat/dock.ts and the Realtime
// plumbing in lib/chat/signals.ts + lib/chat/live.ts (module singletons).
import Link from 'next/link';
import { useEffect } from 'react';
import { useConversations, useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { setChatVisible } from '@/lib/settings';
import { findDm } from '@/lib/messages';
import { dock, useDock } from '@/lib/chat/dock';
import { signals, useSignalsVersion } from '@/lib/chat/signals';
import { live, rekeyWhereNeeded } from '@/lib/chat/live';
import { Avatar } from './Avatar';
import { ChatWindow } from './messages/ChatWindow';
import '@/styles/messages.css';

export function ChatDock() {
  const { status, userId } = useSession();
  const ready = status === 'ready' && !!userId;
  const friends = useFriendIds();
  const convs = useConversations();
  const state = useDock();
  useSignalsVersion();
  usePeopleVersion();

  // Start the module services once per signed-in, unlocked user.
  useEffect(() => {
    if (!ready) return;
    signals.start(userId!);
    live.start(userId!);
  }, [ready, userId]);
  useEffect(() => { if (friends.data) signals.setFriends(friends.data); }, [friends.data]);
  useEffect(() => {
    if (!convs.data) return;
    signals.setConversations(convs.data);
    rekeyWhereNeeded(convs.data);
  }, [convs.data]);

  // New message in a one-to-one chat while I'm not looking at it: pop its chat window
  // (minimised windows flash orange). Typing stops when the message arrives.
  useEffect(() => {
    if (!ready) return;
    return live.onMessage((m) => {
      signals.clearTyping(m.conversation_id, m.sender_id);
      if (live.viewing() === m.conversation_id) return;
      const c = convs.data?.find((x) => x.id === m.conversation_id);
      if (c && !c.isDm) return;
      if (!c) {
        // A conversation we haven't listed yet: only a DM with this sender qualifies.
        void findDm(m.sender_id).then((d) => { if (d?.id === m.conversation_id) dock.open({ convId: d.id, userId: m.sender_id }); }).catch(() => undefined);
        return;
      }
      dock.open({ convId: c.id, userId: m.sender_id });
    });
  }, [ready, convs.data]);

  const online = signals.onlineFriends()
    .map((o) => ({ ...o, name: people.person(o.id)?.name ?? '…' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!ready) return null;
  const visible = signals.isVisible();

  const openFriend = async (id: string) => {
    dock.open({ userId: id }, { focus: true });
    const d = await findDm(id).catch(() => null);
    if (d) dock.attach(id, d.id);
  };

  return (
    <div id="chatdock" aria-label="Chat">
      {state.wins.map((w) => <ChatWindow key={`${w.convId ?? ''}|${w.userId ?? ''}`} win={w} />)}
      <div className="cbar">
        {state.list && (
          <div className="blist" role="dialog" aria-label="Friends online">
            <div className="bh">
              <span>Chat</span>
              <span className="kwc-bh">
                <a role="button" tabIndex={0} onClick={() => setChatVisible(!visible)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChatVisible(!visible); } }}>
                  {visible ? 'Go Offline' : 'Go Online'}
                </a>
                <a role="button" tabIndex={0} title="Minimize" aria-label="Minimize chat list" onClick={() => dock.toggleList()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dock.toggleList(); } }}>&minus;</a>
              </span>
            </div>
            <div className="bl">
              {!visible && <div className="gray kwc-pad">You&rsquo;re offline. Friends can&rsquo;t see that you&rsquo;re online, and you can&rsquo;t see them.</div>}
              {visible && online.map((f) => (
                <a key={f.id} className="bu" role="button" tabIndex={0} onClick={() => void openFriend(f.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openFriend(f.id); } }}>
                  <Avatar id={f.id} size={24} />
                  <span className="kwc-bname">{f.name}</span>
                  <span className={`dot${f.status === 'idle' ? ' idle' : ''}`} title={f.status === 'idle' ? 'Idle' : 'Online'} />
                </a>
              ))}
              {visible && !online.length && <div className="gray kwc-pad">No friends are available to chat.</div>}
            </div>
            <div className="kwc-foot"><Link href="/messages">See All Messages</Link></div>
          </div>
        )}
        <div className="ctab" role="button" tabIndex={0} aria-expanded={state.list} onClick={() => dock.toggleList()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dock.toggleList(); } }}>
          <span className={visible ? 'dot' : 'dot kwc-off'} />Chat {visible ? `(${online.length})` : '(Offline)'}
        </div>
      </div>
    </div>
  );
}
