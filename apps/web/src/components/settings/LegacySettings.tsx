'use client';
// Settings → Security: legacy contact (docs/v2/03-safety.md §11). Two sections: choosing my own legacy contact
// (one connection, an inactivity period and an optional note sealed on this device), and the people who chose
// me (step back before release; read their note and, if I wish, remember their profile after it).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import {
  LegacyError, declineLegacy, legacyRoles, myLegacy, readLegacyNote, readMyNote, rememberAccount, removeLegacy, saveLegacy,
  type LegacyRole, type LegacyRow,
} from '@/lib/legacy/legacy';
import { LEGACY_MONTHS, NOTE_MAX, isLegacyMonths, noteFits, type LegacyMonths } from '@/lib/legacy/model';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Segmented';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { PersonAvatar } from '@/components/messages/look';
import { PeoplePicker } from '@/components/messages/PeoplePicker';
import { Section } from './shared';

const ERRORS: Record<string, MessageKey> = {
  key_changed: 'legacy.keyChanged', not_connected: 'legacy.notConnected', too_long: 'legacy.tooLong',
};

// ---------------------------------------------------------------------------------------------- my legacy contact

export function LegacySection() {
  const t = useT();
  const toast = useToast();
  usePeopleVersion();
  const { status } = useSession();
  const q = useQuery({
    queryKey: ['legacy', 'mine'], enabled: status === 'ready',
    queryFn: async (): Promise<LegacyRow | null> => {
      const r = await myLegacy();
      if (r) await people.ensure([r.contact_id]);
      return r;
    },
  });
  const row = q.isError ? null : q.data;
  const load = () => q.refetch();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [months, setMonths] = useState<LegacyMonths>(6);
  const [note, setNote] = useState('');
  const [lostNote, setLostNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const nameOf = (id: string | undefined) => (id ? people.person(id)?.name : null) ?? t('messages.someone');
  const pickedName = picked[0] ? nameOf(picked[0]) : null;

  function edit() {
    setErr(null);
    if (row) {
      const text = readMyNote(row);
      setPicked([row.contact_id]);
      setMonths(isLegacyMonths(row.inactive_months) ? row.inactive_months : 6);
      setNote(text ?? '');
      setLostNote(!!row.sealed_self && text === null);
    } else {
      setPicked([]); setMonths(6); setNote(''); setLostNote(false);
    }
    setEditing(true);
  }

  async function save() {
    const contact = picked[0];
    if (!contact) { setErr(t('legacy.pickOne')); return; }
    if (!noteFits(note)) { setErr(t('legacy.tooLong')); return; }
    setBusy(true); setErr(null);
    try {
      await saveLegacy(contact, months, note);
      setEditing(false); setNote('');
      toast({ message: t('legacy.saved', { name: nameOf(contact) }) });
      await load();
    } catch (e) {
      const code = e instanceof LegacyError ? e.code : 'failed';
      setErr(t(ERRORS[code] ?? 'legacy.failed', { name: nameOf(contact) }));
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setErr(null);
    try { await removeLegacy(); setConfirmRemove(false); toast({ message: t('legacy.removed') }); await load(); }
    catch { setErr(t('legacy.failed')); }
    finally { setBusy(false); }
  }

  const name = row ? nameOf(row.contact_id) : '';
  return (
    <Section id="legacy" title={t('legacy.title')} description={t('legacy.body')}>
      {err ? <Callout tone="danger">{err}</Callout> : null}
      {q.isError ? <Callout tone="danger">{t('legacy.failed')}</Callout> : null}
      {!editing && row === undefined ? <Skeleton height={48} /> : null}
      {!editing && row ? (
        <>
          <ul className="k-set-items">
            <li>
              <PersonAvatar id={row.contact_id} size={36} />
              <span className="k-set-item-body">
                <span className="k-set-item-title">{t('legacy.current', { name })}</span>
                <span className="k-small k-muted">{row.sealed_note ? t('legacy.noteSealed', { name }) : t('legacy.noNote')}</span>
              </span>
            </li>
          </ul>
          <p>{t(row.sealed_note ? 'legacy.period' : 'legacy.periodNoNote', { months: row.inactive_months, name })}</p>
          <p className="k-small k-muted">{t('legacy.hold')}</p>
          <div className="k-row-wrap">
            <Button variant="secondary" onClick={edit}>{t('legacy.change')}</Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>{t('legacy.remove')}</Button>
          </div>
        </>
      ) : null}
      {!editing && row === null ? <div><Button variant="primary" icon="heart" onClick={edit}>{t('legacy.choose')}</Button></div> : null}
      {editing ? (
        <div className="k-stack">
          <p className="k-small"><b>{t('legacy.step1')}</b> {t('legacy.step1Hint')}</p>
          <PeoplePicker single max={1} selected={picked} onToggle={(id) => setPicked((p) => (p.includes(id) ? [] : [id]))} />
          <p className="k-small"><b>{t('legacy.step2')}</b></p>
          <Segmented label={t('legacy.step2')} value={String(months)} onChange={(v) => setMonths(Number(v) as LegacyMonths)}
            options={LEGACY_MONTHS.map((m) => ({ value: String(m), label: t('legacy.months', { count: m }) }))} />
          {lostNote ? <Callout tone="warning">{t('legacy.lostNote')}</Callout> : null}
          <Textarea label={t('legacy.step3')} value={note} rows={6} dir="auto" maxLength={NOTE_MAX}
            hint={`${pickedName ? t('legacy.noteHint', { name: pickedName }) : t('legacy.noteHintNoName')} ${t('legacy.noteCount', { count: note.length, max: NOTE_MAX })}`}
            onChange={(e) => setNote(e.target.value)} />
          <p className="k-small k-muted">{t('legacy.limits')}</p>
          <div className="k-row-wrap">
            <Button variant="primary" busy={busy} onClick={() => void save()}>{t('legacy.save')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setErr(null); setNote(''); }}>{t('settings.cancel')}</Button>
          </div>
        </div>
      ) : null}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)} title={t('legacy.removeTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>{t('settings.cancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>{t('legacy.remove')}</Button></>}>
        <p className="k-muted">{t('legacy.removeBody', { name })}</p>
      </Dialog>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------- people who chose me

export function LegacyForSection() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  usePeopleVersion();
  const { status } = useSession();
  const q = useQuery({ queryKey: ['legacy', 'for-me'], enabled: status === 'ready', queryFn: legacyRoles });
  const roles: LegacyRole[] | null = q.isError ? [] : q.data ?? null;
  const load = () => q.refetch();
  const [failed, setErr] = useState(false);
  const err = failed || q.isError;
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState<string | null>(null);
  const [remembering, setRemembering] = useState<string | null>(null);
  const [reading, setReading] = useState<{ owner: string; text: string | null; at: string | null; failed: boolean } | null>(null);

  const nameOf = (id: string | null | undefined) => (id ? people.person(id)?.name : null) ?? t('messages.someone');

  async function decline() {
    if (!declining) return;
    const who = declining;
    setBusy(true);
    try { await declineLegacy(who); setDeclining(null); toast({ message: t('legacy.for.declined', { name: nameOf(who) }) }); await load(); }
    catch { setErr(true); }
    finally { setBusy(false); }
  }

  async function read(owner: string) {
    setReading({ owner, text: null, at: null, failed: false });
    try {
      const n = await readLegacyNote(owner);
      setReading({ owner, text: n?.text ?? null, at: n?.writtenAt ?? null, failed: !n });
    } catch { setReading({ owner, text: null, at: null, failed: true }); }
  }

  async function remember(owner: string, on: boolean) {
    setBusy(true);
    try {
      await rememberAccount(owner, on);
      setRemembering(null);
      if (on) toast({ message: t('legacy.for.remembered', { name: nameOf(owner) }) });
      await load();
    } catch { setErr(true); }
    finally { setBusy(false); }
  }

  if (roles !== null && !roles.length && !err) return null;   // nothing to show for most people
  return (
    <Section id="legacy-for" title={t('legacy.for.title')}>
      {err ? <Callout tone="danger">{t('legacy.failed')}</Callout> : null}
      {roles === null ? <Skeleton height={40} /> : null}
      {(roles ?? []).map((r) => {
        const name = nameOf(r.owner_id);
        const memorial = !!people.get(r.owner_id)?.memorialised_at;
        return (
          <div key={r.owner_id} className="k-stack-sm">
            <ul className="k-set-items">
              <li>
                <PersonAvatar id={r.owner_id} size={36} />
                <span className="k-set-item-body">
                  <span className="k-set-item-title">{r.released_at ? t('legacy.for.released', { name }) : t('legacy.for.chosen', { name })}</span>
                  <span className="k-small k-muted">
                    {r.released_at ? (r.has_note ? t('legacy.for.releasedNote') : t('legacy.for.releasedNoNote', { name })) : t('legacy.for.chosenBody', { name })}
                  </span>
                </span>
              </li>
            </ul>
            {r.released_at ? (
              <div className="k-row-wrap">
                {r.has_note ? <Button variant="primary" icon="heart" onClick={() => void read(r.owner_id)}>{t('legacy.for.read')}</Button> : null}
                {memorial
                  ? <>
                      <span className="k-small k-muted">{t('legacy.for.remembering', { name })}</span>
                      <Button variant="ghost" busy={busy} onClick={() => void remember(r.owner_id, false)}>{t('legacy.for.stopRemembering')}</Button>
                    </>
                  : <Button variant="secondary" onClick={() => setRemembering(r.owner_id)}>{t('legacy.for.remember', { name })}</Button>}
              </div>
            ) : (
              <div><Button variant="ghost" size="sm" onClick={() => setDeclining(r.owner_id)}>{t('legacy.for.decline')}</Button></div>
            )}
          </div>
        );
      })}

      <Dialog open={!!declining} onClose={() => setDeclining(null)} dismissible={!busy}
        title={t('legacy.for.declineTitle', { name: nameOf(declining) })}
        footer={<><Button variant="ghost" onClick={() => setDeclining(null)} disabled={busy}>{t('settings.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => void decline()}>{t('legacy.for.decline')}</Button></>}>
        <p className="k-muted">{t('legacy.for.declineBody', { name: nameOf(declining) })}</p>
      </Dialog>

      <Dialog open={!!remembering} onClose={() => setRemembering(null)} dismissible={!busy}
        title={t('legacy.for.rememberTitle', { name: nameOf(remembering) })}
        footer={<><Button variant="ghost" onClick={() => setRemembering(null)} disabled={busy}>{t('settings.cancel')}</Button>
          <Button variant="primary" busy={busy} onClick={() => { if (remembering) void remember(remembering, true); }}>{t('legacy.for.rememberCta')}</Button></>}>
        <p className="k-muted">{t('legacy.for.rememberBody', { name: nameOf(remembering) })}</p>
      </Dialog>

      <Dialog open={!!reading} onClose={() => setReading(null)} title={t('legacy.for.noteTitle', { name: nameOf(reading?.owner) })}
        footer={<Button variant="primary" onClick={() => setReading(null)}>{t('common.close')}</Button>}>
        {reading && !reading.text && !reading.failed ? <Skeleton height={64} /> : null}
        {reading?.failed ? <Callout tone="warning">{t('legacy.for.unverified')}</Callout> : null}
        {reading?.text ? (
          <div className="k-stack-sm">
            <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reading.text}</p>
            {reading.at ? <p className="k-small k-muted">{t('legacy.for.written', { date: f.date(new Date(reading.at), { dateStyle: 'long' }) })}</p> : null}
          </div>
        ) : null}
      </Dialog>
    </Section>
  );
}
