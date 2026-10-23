'use client';
// Small building blocks shared by posts, comments, stories and profiles.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Icon, type IconName } from '@/components/ui/Icon';
import { getGroup, readGroup } from '@/lib/groups';
import { useKeyringVersion } from '@/lib/hooks';
import { usePeopleVersion } from '@/lib/people';
import { renderMarkdown } from '@/components/auth/Markdown';
import { safeLink } from '@/components/notes/format';
import { ExternalLink } from '@/components/links/ExternalLink';
import { segmentText, whenParts } from './logic';
import type { AudienceBadge } from './data';

export { EXTERNAL_REL } from '@/lib/links/leave';

/** "5 min ago", "Yesterday", "12 Mar" in the active language; the full date is in the tooltip. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const t = useT();
  const f = useFormat();
  const w = whenParts(iso);
  const d = new Date(iso);
  const text = w.kind === 'now' ? t('feed.justNow')
    : w.kind === 'relative' ? f.relative(w.value, w.unit)
    : f.date(d, w.sameYear ? { day: 'numeric', month: 'short' } : { dateStyle: 'medium' });
  return <time className={className} dateTime={d.toISOString()} title={f.date(d, { dateStyle: 'full', timeStyle: 'short' })}>{text}</time>;
}

/** Post/comment text: newlines kept, http(s) links open through "Leaving Kithwall", long text folded. */
export function RichText({ text, clamp = 700, className }: { text: string; clamp?: number; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > clamp;
  const shown = long && !open ? `${text.slice(0, clamp).replace(/\s+\S*$/, '')}…` : text;
  return (
    <div className={className ? `k-rich ${className}` : 'k-rich'} dir="auto">
      {segmentText(shown).map((s, i) => s.kind === 'link'
        ? <ExternalLink key={i} href={s.href} text={s.text} className="k-ltr">{s.text}</ExternalLink>
        : <span key={i}>{s.text}</span>)}
      {long ? (
        <> <button type="button" className="k-linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('feed.showLess') : t('feed.readMore')}
        </button></>
      ) : null}
    </div>
  );
}

/**
 * A note's body (Markdown subset, see components/notes/format.ts) rendered with the safe Markdown
 * renderer: React elements only, links limited to http(s). Long notes are folded like RichText.
 */
export function NoteText({ md, clamp = 700 }: { md: string; clamp?: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = md.length > clamp;
  const shown = long && !open ? `${md.slice(0, clamp).replace(/\s+\S*$/, '')}…` : md;
  return (
    <div className="k-post-note-body kn-prose" dir="auto">
      {renderMarkdown(shown, safeLink)}
      {long ? (
        <p><button type="button" className="k-linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('feed.showLess') : t('feed.readMore')}
        </button></p>
      ) : null}
    </div>
  );
}

/** A circle's (decrypted) name, or the generic "Circle" label until it can be read. */
export function useCircleName(circleId: string | null | undefined): string | null {
  useKeyringVersion();
  usePeopleVersion();
  const q = useQuery({ queryKey: ['circle-row', circleId], enabled: !!circleId, staleTime: 5 * 60_000, queryFn: () => getGroup(circleId!) });
  if (!circleId || !q.data) return null;
  const d = readGroup(q.data);
  return d.ok ? d.value.name : q.data.name_public ?? null;
}

export function AudienceTag({ audience }: { audience: AudienceBadge }) {
  const t = useT();
  const circle = useCircleName(audience.kind === 'circle' ? audience.circleId : null);
  let icon: IconName = 'users';
  let label: string;
  switch (audience.kind) {
    case 'connections': label = t('feed.audienceConnections'); break;
    case 'some': label = t('feed.audienceSome'); break;
    case 'only_me': icon = 'lock'; label = t('feed.audienceOnlyMe'); break;
    case 'public': icon = 'globe'; label = t('feed.audiencePublic'); break;
    case 'event': icon = 'calendar'; label = t('feed.audienceEvent'); break;
    case 'circle': icon = 'circles'; label = circle ?? t('feed.audienceCircle'); break;
  }
  return (
    <span className="k-aud" title={t('feed.sharedWith', { audience: label })}>
      <Icon name={icon} /><span className="k-aud-label" aria-hidden>{label}</span>
      <span className="k-sr-only">{t('feed.sharedWith', { audience: label })}</span>
    </span>
  );
}

export function formatBytes(n: number, number: (n: number, o?: Intl.NumberFormatOptions) => string): string {
  if (n >= 1024 * 1024) return number(n / (1024 * 1024), { style: 'unit', unit: 'megabyte', maximumFractionDigits: n >= 10 * 1024 * 1024 ? 0 : 1 });
  if (n >= 1024) return number(Math.round(n / 1024), { style: 'unit', unit: 'kilobyte' });
  return number(n, { style: 'unit', unit: 'byte' });
}

export function formatDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
