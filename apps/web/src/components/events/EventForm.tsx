'use client';
// Event details form (create + edit) — reference vNewEvent.
import { useState, type FormEvent, type ReactNode } from 'react';
import { ErrorBox, PublicWarning, useAction } from '@/components/groups/bits';
import type { EventInfo } from '@/lib/events';

const pad = (n: number) => String(n).padStart(2, '0');
const toDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function EventForm({ initial, submitLabel, onSubmit, onCancel, extra, isPublic }:
  { initial?: EventInfo; submitLabel: string; onSubmit: (info: EventInfo) => Promise<void>; onCancel: () => void; extra?: ReactNode; isPublic?: boolean }) {
  const [start0] = useState(() => (initial ? new Date(initial.start) : (() => { const d = new Date(Date.now() + 3 * 86400_000); d.setHours(20, 0, 0, 0); return d; })()));
  const end0 = initial?.end ? new Date(initial.end) : null;
  const [date, setDate] = useState(toDate(start0));
  const [time, setTime] = useState(toTime(start0));
  const [hasEnd, setHasEnd] = useState(!!end0);
  const [endDate, setEndDate] = useState(toDate(end0 ?? new Date(start0.getTime() + 3 * 3600_000)));
  const [endTime, setEndTime] = useState(toTime(end0 ?? new Date(start0.getTime() + 3 * 3600_000)));
  const [name, setName] = useState(initial?.name ?? '');
  const [tagline, setTagline] = useState(initial?.tagline ?? '');
  const [where, setWhere] = useState(initial?.where ?? '');
  const [street, setStreet] = useState(initial?.street ?? '');
  const [desc, setDesc] = useState(initial?.description ?? '');
  const { busy, error, setError, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Please tell your guests what you\'re planning.'); return; }
    const start = new Date(`${date}T${time || '00:00'}`);
    if (Number.isNaN(start.getTime())) { setError('Please choose a valid date and time.'); return; }
    let end: Date | null = null;
    if (hasEnd) {
      end = new Date(`${endDate}T${endTime || '00:00'}`);
      if (Number.isNaN(end.getTime()) || end <= start) { setError('The end time must be after the start time.'); return; }
    }
    const info: EventInfo = {
      name: name.trim().slice(0, 120), start: start.toISOString(),
      ...(end ? { end: end.toISOString() } : {}),
      ...(tagline.trim() ? { tagline: tagline.trim().slice(0, 140) } : {}),
      ...(where.trim() ? { where: where.trim().slice(0, 200) } : {}),
      ...(street.trim() ? { street: street.trim().slice(0, 200) } : {}),
      ...(desc.trim() ? { description: desc.trim().slice(0, 4000) } : {}),
      ...(initial?.cancelled ? { cancelled: true } : {}),
    };
    await run(() => onSubmit(info));
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <ErrorBox error={error} />
      <table className="form"><tbody>
        <tr><td className="l">When?</td><td>
          <div className="cm-when">
            <input type="date" aria-label="Date" value={date} required onChange={(e) => setDate(e.target.value)} />
            <span>at</span>
            <input type="time" aria-label="Start time" value={time} step={300} onChange={(e) => setTime(e.target.value)} />
          </div>
          <label style={{ display: 'block', marginTop: 4 }}><input type="checkbox" checked={hasEnd} onChange={(e) => setHasEnd(e.target.checked)} /> Add end time</label>
          {hasEnd && <div className="cm-when" style={{ marginTop: 4 }}>
            <input type="date" aria-label="End date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            <span>at</span>
            <input type="time" aria-label="End time" value={endTime} step={300} onChange={(e) => setEndTime(e.target.value)} />
          </div>}
        </td></tr>
        <tr><td className="l"><label htmlFor="ev-name">What are you planning?</label></td>
          <td><input id="ev-name" type="text" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="ev-tag">Tagline:</label></td>
          <td><input id="ev-tag" type="text" value={tagline} maxLength={140} placeholder="Optional" onChange={(e) => setTagline(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="ev-where">Where?</label></td>
          <td><input id="ev-where" type="text" value={where} maxLength={200} onChange={(e) => setWhere(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="ev-street">Street address:</label></td>
          <td><input id="ev-street" type="text" value={street} maxLength={200} placeholder="Optional" onChange={(e) => setStreet(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="ev-desc">More info?</label></td>
          <td><textarea id="ev-desc" value={desc} maxLength={4000} onChange={(e) => setDesc(e.target.value)} /></td></tr>
        {extra}
        {isPublic && <tr><td /><td><PublicWarning what="This event's details and wall" /></td></tr>}
        <tr><td /><td>
          <button type="submit" className="btn b" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>{' '}
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </td></tr>
      </tbody></table>
    </form>
  );
}
