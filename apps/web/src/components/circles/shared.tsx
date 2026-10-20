'use client';
// Small building blocks shared by the circles, events, albums and notes screens (Kithwall 2).
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import { useFriendIds } from '@/lib/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { cx } from '@/components/ui/cx';
import { circleMark, toneOf, type CircleTone } from './look';
import { useCircleOptions, type CircleInfo } from './data';

// ---------------------------------------------------------------------------------------
// People

export function PersonAvatar({ id, size = 40 }: { id: string | null | undefined; size?: number }) {
  const p = usePerson(id);
  const url = useFileUrl(p?.info?.avatar?.thumb);
  return <Avatar name={p?.name ?? ''} src={url} size={size} />;
}

export function usePersonName(id: string | null | undefined): string {
  const p = usePerson(id);
  return p?.name ?? '…';
}

export function PersonName({ id }: { id: string | null | undefined }) {
  return <>{usePersonName(id)}</>;
}

/** Overlapping avatars ("Sara, Dan and 3 others"). */
export function AvatarStack({ ids, max = 4, size = 28 }: { ids: string[]; max?: number; size?: number }) {
  const shown = ids.slice(0, max);
  return (
    <span className="kc-stack" aria-hidden>
      {shown.map((id) => <PersonAvatar key={id} id={id} size={size} />)}
      {ids.length > max ? <span className="kc-stack-more">+{ids.length - max}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Circle mark (emoji or first letter on the circle's tone)

export function CircleMark({ id, info, size = 'md' }: { id: string; info: CircleInfo | null; size?: 'sm' | 'md' | 'lg' }) {
  const tone: CircleTone = toneOf(id, info?.tone);
  return (
    <span className={cx('kc-mark', `kc-mark-${size}`)} data-tone={tone} aria-hidden>
      {info?.emoji || circleMark(info?.name ?? '')}
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Status bits

/** Shown in place of content we can't decrypt yet (waiting for a key) or couldn't verify. */
export function SealedNote({ reason }: { reason: 'waiting' | 'unverified' }) {
  const t = useT();
  return (
    <p className="kc-sealed k-small k-muted">
      <Icon name={reason === 'waiting' ? 'lock' : 'alert'} />
      <span>{reason === 'waiting' ? t('circles.ui.waitingKey') : t('circles.ui.unverified')}</span>
    </p>
  );
}

export function Loading() {
  const t = useT();
  return <div className="kc-loading" role="status"><Spinner label={t('common.loading')} /></div>;
}

export function NotFound({ icon, title, body, actions }: { icon: IconName; title: string; body?: string; actions?: ReactNode }) {
  return <Card><EmptyState icon={icon} title={title} body={body} actions={actions} /></Card>;
}

export function E2eeLine({ children }: { children: ReactNode }) {
  return <p className="kc-e2ee k-xs k-muted"><Icon name="lock" /><span>{children}</span></p>;
}

// ---------------------------------------------------------------------------------------
// Form controls not in the shared UI kit

export function SelectField<T extends string>({ label, value, onChange, options, hint, id: idProp }: {
  label: ReactNode; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; hint?: ReactNode; id?: string;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className="k-field">
      <label className="k-label" htmlFor={id}>{label}</label>
      <div className="k-control kc-select">
        <select id={id} className="k-input" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="k-control-affix" aria-hidden><Icon name="down" /></span>
      </div>
      {hint ? <span className="k-hint">{hint}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Audience (who can see an album / note / event)

export type ShareAudience = { kind: 'connections' } | { kind: 'only_me' } | { kind: 'circle'; circleId: string };

export function audienceValue(a: ShareAudience): string {
  return a.kind === 'circle' ? `circle:${a.circleId}` : a.kind;
}
export function parseAudience(v: string): ShareAudience {
  if (v.startsWith('circle:')) return { kind: 'circle', circleId: v.slice(7) };
  return v === 'only_me' ? { kind: 'only_me' } : { kind: 'connections' };
}

/** Audience picker: my connections, only me, or one of my circles. */
export function AudiencePicker({ value, onChange, allowOnlyMe = true, allowConnections = true, label }: {
  value: ShareAudience; onChange: (a: ShareAudience) => void; allowOnlyMe?: boolean; allowConnections?: boolean; label?: string;
}) {
  const t = useT();
  const { options } = useCircleOptions();
  const opts = [
    ...(allowConnections ? [{ value: 'connections', label: t('circles.aud.connections') }] : []),
    ...(allowOnlyMe ? [{ value: 'only_me', label: t('circles.aud.onlyMe') }] : []),
    ...options.map((o) => ({ value: `circle:${o.id}`, label: t('circles.aud.circle', { name: o.info?.name ?? t('circles.ui.sealedCircle') }) })),
  ];
  return (
    <SelectField
      label={label ?? t('circles.aud.label')}
      value={audienceValue(value)}
      onChange={(v) => onChange(parseAudience(v))}
      options={opts}
      hint={value.kind === 'only_me' ? t('circles.aud.onlyMeHint') : value.kind === 'circle' ? t('circles.aud.circleHint') : t('circles.aud.connectionsHint')}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Connection picker (multi-select), used to invite people to circles and events

export function ConnectionPicker({ value, onChange, exclude = [], candidates, emptyText }: {
  value: string[]; onChange: (ids: string[]) => void; exclude?: string[];
  /** Restrict to these people (default: my connections). */
  candidates?: string[];
  emptyText?: string;
}) {
  const t = useT();
  const friends = useFriendIds();
  const [q, setQ] = useState('');
  const base = candidates ?? friends.data ?? [];
  const ids = useMemo(() => [...new Set(base)].filter((id) => !exclude.includes(id)), [base, exclude]);
  const loading = !candidates && friends.isLoading;
  if (loading) return <Loading />;
  if (!ids.length) return <p className="k-muted k-small">{emptyText ?? t('circles.pick.none')}</p>;
  return (
    <div className="kc-picker">
      {ids.length > 6 ? (
        <div className="k-control">
          <span className="k-control-affix" aria-hidden><Icon name="search" /></span>
          <input className="k-input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t('circles.pick.search')} aria-label={t('circles.pick.search')} />
        </div>
      ) : null}
      <ul className="k-list kc-picker-list" role="list">
        {ids.map((id) => <PickRow key={id} id={id} q={q} on={value.includes(id)}
          toggle={() => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])} />)}
      </ul>
      {value.length ? <p className="k-small k-muted" aria-live="polite">{t('circles.pick.count', { count: value.length })}</p> : null}
    </div>
  );
}

function PickRow({ id, q, on, toggle }: { id: string; q: string; on: boolean; toggle: () => void }) {
  const p = usePerson(id);
  const name = p?.name ?? '…';
  if (q && !`${name} ${p?.username ?? ''}`.toLowerCase().includes(q.toLowerCase())) return null;
  return (
    <li>
      <label className="k-item kc-pick">
        <PersonAvatar id={id} size={36} />
        <span className="k-item-body">
          <span className="k-item-title">{name}</span>
          {p?.username ? <span className="k-item-sub k-ltr">@{p.username}</span> : null}
        </span>
        <input type="checkbox" className="kc-check" checked={on} onChange={toggle} />
      </label>
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// Misc

/** Section heading + optional action, as used on the list screens. */
export function SectionHead({ title, action, id }: { title: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="kc-section-head">
      <h2 id={id} className="k-section-title">{title}</h2>
      {action}
    </div>
  );
}

/** A file-picker button (the input is visually hidden but stays keyboard accessible). */
export function FileButton({ label, accept, multiple, onFiles, icon = 'image', variant = 'primary', disabled, size }: {
  label: string; accept: string; multiple?: boolean; onFiles: (files: File[]) => void; icon?: IconName;
  variant?: 'primary' | 'soft' | 'secondary'; disabled?: boolean; size?: 'sm';
}) {
  const id = useId();
  return (
    <span className="kc-filebtn">
      <input id={id} type="file" accept={accept} multiple={multiple} className="k-sr-only" disabled={disabled}
        onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onFiles(f); }} />
      <label htmlFor={id} className={cx('k-btn', `k-btn-${variant}`, size === 'sm' && 'k-btn-sm')} aria-disabled={disabled || undefined}>
        <Icon name={icon} /><span>{label}</span>
      </label>
    </span>
  );
}
