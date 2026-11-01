'use client';
// "Call in progress · Join" (late join, docs/v2/04-calls.md §14) in the chat header and the conversation
// list. The hint comes from a participant of the call, sealed, on my ring topic (lib/calls/live.ts);
// joining enters the call like answering its ring (calls.joinLive).
import { useT } from '@/i18n';
import { calls, MAX_CALL_PEOPLE, useCall } from '@/lib/calls/engine';
import { isLive } from '@/lib/calls/machine';
import { useLiveCall } from '@/lib/calls/live';
import { cx } from '@/components/ui/cx';
import { CallIcon } from './CallIcon';

/** The call going on in this conversation that I could join (null when there's none, or I'm in it). */
export function useJoinable(convId: string) {
  const live = useLiveCall(convId);
  const s = useCall();
  if (!live || (s.callId === live.callId && isLive(s.m.phase))) return null;
  return { live, busy: isLive(s.m.phase) || s.m.phase === 'incoming', full: live.n >= MAX_CALL_PEOPLE };
}

export function LiveCallJoin({ convId, variant }: { convId: string; variant: 'head' | 'row' }) {
  const t = useT();
  const j = useJoinable(convId);
  if (!j) return null;
  const label = t('calls.live.joinLabel', { count: j.live.n });
  const why = j.full ? t('calls.live.full') : j.busy ? t('calls.alreadyInCall') : null;
  return (
    <button type="button" className={cx('k-call-join', `is-${variant}`)} disabled={!!why} onClick={() => void calls.joinLive(convId)}
      aria-label={why ? `${label} (${why})` : label} title={why ?? label}>
      <span className="k-call-join-dot" aria-hidden />
      {variant === 'head' ? <span className="k-call-join-what">{t('calls.live.title')} · {t('calls.live.people', { count: j.live.n })}</span> : null}
      <CallIcon name={j.live.video ? 'video' : 'phone'} size={16} />
      <span>{t('calls.live.join')}</span>
    </button>
  );
}
