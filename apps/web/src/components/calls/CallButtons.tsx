'use client';
// Voice and video call buttons for a chat header (1:1, group and circle chats up to 8 people). In a narrow
// header (phones, the split view) the two buttons collapse into one "Call" menu so the chat title keeps
// its room; which one shows is decided by a container query on .k-chat-head (styles/v2/calls.css).
// Opening a chat with these buttons warms the TURN credentials (docs/v2/04-calls.md §12).
import { useEffect } from 'react';
import { useT } from '@/i18n';
import { prefetchIceConfig } from '@/lib/calls/turn';
import type { ConversationSummary } from '@/lib/messages';
import { calls, MAX_CALL_PEOPLE, useCall } from '@/lib/calls/engine';
import { isLive } from '@/lib/calls/machine';
import { useSession } from '@/lib/keys/session';
import { Menu } from '@/components/posts/Menu';
import { CallIcon } from './CallIcon';

export function CallButtons({ conversation: c }: { conversation: ConversationSummary }) {
  const t = useT();
  const s = useCall();
  const { userId } = useSession();
  const others = c.members.filter((m) => m !== userId).length;
  // A chat you can call from is open: get the call relay's credentials ready now, so tapping Call doesn't
  // wait for them (lib/calls/turn.ts; cached for most of an hour).
  useEffect(() => { if (others) prefetchIceConfig(); }, [others]);
  if (!others) return null;
  const tooMany = c.members.length > MAX_CALL_PEOPLE;
  const busy = isLive(s.m.phase) || s.m.phase === 'incoming';
  const disabled = tooMany || busy;
  const why = tooMany ? t('calls.tooMany', { count: MAX_CALL_PEOPLE }) : busy ? t('calls.alreadyInCall') : null;
  const btn = (video: boolean) => {
    const label = video ? t('calls.videoCall') : t('calls.voiceCall');
    return (
      <button type="button" className="k-iconbtn k-call-headbtn" aria-label={why ? `${label} (${why})` : label} title={why ?? label}
        disabled={disabled} onClick={() => void calls.place(c, video)}>
        <CallIcon name={video ? 'video' : 'phone'} />
      </button>
    );
  };
  const menuLabel = t('calls.callMenu');
  return (
    <>
      <span className="k-call-headbtns">{btn(false)}{btn(true)}</span>
      <span className="k-call-headcompact">
        {disabled ? (
          <button type="button" className="k-iconbtn k-call-headbtn" disabled aria-label={`${menuLabel} (${why})`} title={why ?? menuLabel}>
            <CallIcon name="phone" />
          </button>
        ) : (
          <Menu label={menuLabel} buttonClassName="k-iconbtn k-call-headbtn" trigger={<CallIcon name="phone" />} items={[
            { label: t('calls.voiceCall'), iconNode: <CallIcon name="phone" />, onSelect: () => void calls.place(c, false) },
            { label: t('calls.videoCall'), iconNode: <CallIcon name="video" />, onSelect: () => void calls.place(c, true) },
          ]} />
        )}
      </span>
    </>
  );
}
