'use client';
import { useMemo } from 'react';
import { useLocale } from '@/i18n';
import { deviceTimeZone, isValidTimeZone } from './time';
import type { EventInfo2 } from './data';

/** Locale-aware event time formatting in the viewer's zone (plus the host's zone when it differs). */
export function useEventTime() {
  const { tag } = useLocale();
  return useMemo(() => {
    const here = deviceTimeZone();
    const dateFmt = new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const timeFmt = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
    const zoneFmt = (tz: string) => new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
    const month = new Intl.DateTimeFormat(tag, { month: 'short' });
    const day = new Intl.DateTimeFormat(tag, { day: 'numeric' });
    const shortFmt = new Intl.DateTimeFormat(tag, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return {
      /** "Thursday, 5 November 2026" */
      date: (iso: string) => dateFmt.format(new Date(iso)),
      /** "19:30 – 22:00" in the viewer's zone */
      range: (info: Pick<EventInfo2, 'start' | 'end'>) => {
        const s = new Date(info.start);
        if (!info.end) return timeFmt.format(s);
        const e = new Date(info.end);
        return s.toDateString() === e.toDateString()
          ? timeFmt.formatRange?.(s, e) ?? `${timeFmt.format(s)} – ${timeFmt.format(e)}`
          : `${timeFmt.format(s)} – ${shortFmt.format(e)}`;
      },
      /** "19:30 PKT" in the host's zone when it differs from the viewer's, else null. */
      hostZone: (info: Pick<EventInfo2, 'start' | 'tz'>) =>
        info.tz && isValidTimeZone(info.tz) && info.tz !== here ? zoneFmt(info.tz).format(new Date(info.start)) : null,
      short: (iso: string) => shortFmt.format(new Date(iso)),
      badge: (iso: string) => ({ month: month.format(new Date(iso)), day: day.format(new Date(iso)) }),
    };
  }, [tag]);
}
