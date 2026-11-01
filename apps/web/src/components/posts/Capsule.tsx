'use client';
// A time capsule in a post: locked (with the date it opens and a countdown) until drand publishes its
// round, then opened on this device and shown like any post (lib/social/capsule).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/Field';
import { CAPSULE_MAX_MS, CAPSULE_MIN_MS, capsuleReady, openCapsule, type Capsule } from '@/lib/social/capsule';
import type { PostRow } from '@/lib/types';
import { PostBody } from './PostCard';

/** The time now, ticking every 30 s (enough for a countdown in minutes). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  return now;
}

function left(ms: number): { unit: 'days' | 'hours' | 'minutes'; count: number } {
  if (ms >= 86_400_000) return { unit: 'days', count: Math.ceil(ms / 86_400_000) };
  if (ms >= 3_600_000) return { unit: 'hours', count: Math.ceil(ms / 3_600_000) };
  return { unit: 'minutes', count: Math.max(1, Math.ceil(ms / 60_000)) };
}

export function CapsuleView({ capsule, row }: { capsule: Capsule; row?: PostRow }) {
  const t = useT();
  const f = useFormat();
  const now = useNow();
  const ready = capsuleReady(capsule, now);
  const q = useQuery({ queryKey: ['capsule', capsule.ct.slice(-48)], enabled: ready, queryFn: () => openCapsule(capsule), retry: 3, retryDelay: 4000, staleTime: Infinity });
  const when = f.date(new Date(capsule.opens), { dateStyle: 'long', timeStyle: 'short' });
  if (ready && q.data) {
    return (
      <div className="k-capsule is-open">
        <p className="k-capsule-tag k-small"><Icon name="gift" /> {t('capsule.opened', { when })}</p>
        <PostBody payload={q.data} row={row} nested />
      </div>
    );
  }
  const l = left(Date.parse(capsule.opens) - now);
  return (
    <div className="k-capsule" role="note">
      <span className="k-capsule-ico" aria-hidden><Icon name="lock" /></span>
      <p className="k-capsule-title">{t('capsule.locked')}</p>
      <p className="k-small">{t('capsule.opens', { when })}</p>
      {ready
        ? <p className="k-small k-muted">{q.isError ? t('capsule.cantOpen') : t('capsule.opening')}</p>
        : <p className="k-small k-muted">{t(`capsule.left.${l.unit}`, { count: l.count })}</p>}
      <p className="k-xs k-muted">{t('capsule.how')}</p>
    </div>
  );
}

/** Composer: pick when the capsule opens. `value` is a local datetime string or ''. */
export function CapsulePicker({ value, onChange, onRemove }: { value: string; onChange: (v: string) => void; onRemove: () => void }) {
  const t = useT();
  const [min] = useState(() => toLocal(new Date(Date.now() + CAPSULE_MIN_MS)));
  const [max] = useState(() => toLocal(new Date(Date.now() + CAPSULE_MAX_MS)));
  return (
    <div className="k-capsule-edit k-stack-sm">
      <TextField label={t('capsule.pick')} type="datetime-local" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)}
        hint={t('capsule.pickHint')} />
      <div><Button size="sm" variant="ghost" onClick={onRemove}>{t('capsule.remove')}</Button></div>
    </div>
  );
}

export function toLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
