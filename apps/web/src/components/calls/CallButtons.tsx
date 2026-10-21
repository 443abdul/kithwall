'use client';
// Voice and video call buttons for a chat header (1:1, group and circle chats up to 8 people).
import { useT } from '@/i18n';
import type { ConversationSummary } from '@/lib/messages';
import { calls, MAX_CALL_PEOPLE, useCall } from '@/lib/calls/engine';
import { isLive } from '@/lib/calls/machine';
import { useSession } from '@/lib/keys/session';
import { CallIcon } from './CallIcon';

export function CallButtons({ conversation: c }: { conversation: ConversationSummary }) {
  const t = useT();
  const s = useCall();
  const { userId } = useSession();
  const others = c.members.filter((m) => m !== userId).length;
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
  return <span className="k-call-headbtns">{btn(false)}{btn(true)}</span>;
}
