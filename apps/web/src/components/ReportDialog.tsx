'use client';
// Report dialog (2010 dialog style). Owned by the auth/safety work; other areas import it.
// Contract: <ReportDialog kind id disclosure onClose /> — disclosure is built by the caller from the
// item it already decrypted (see lib/report.ts). The dialog explains that reporting shares the
// item's content (and its key) with Kithwall moderators.
import Link from 'next/link';
import { useState } from 'react';
import { REPORT_REASONS, reportItem, type Disclosure, type ReportKind, type ReportReason } from '@/lib/report';
import { Dialog } from '@/components/auth/Dialog';

export interface ReportDialogProps { kind: ReportKind; id: string; disclosure?: Disclosure; onClose: () => void }

const NOUN: Record<ReportKind, string> = {
  post: 'post', comment: 'comment', photo: 'photo', message: 'message', profile: 'profile',
  group: 'group', event: 'event', page: 'Page',
};

export function ReportDialog({ kind, id, disclosure, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const noun = NOUN[kind];
  const sharesContent = !!disclosure && kind !== 'profile';

  async function submit() {
    if (!reason) { setErr('Please choose a reason.'); return; }
    setBusy(true); setErr(null);
    try {
      await reportItem({ kind, id, reason, details: details.trim() || undefined, disclosure });
      setDone(true);
    } catch (e) {
      const m = (e as Error).message;
      setErr(/rate limit/i.test(m) ? 'You\'ve sent a lot of reports today. Please try again tomorrow.'
        : /cannot report/i.test(m) ? 'This item is no longer available.' : 'We couldn\'t send your report. Please try again.');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Dialog title="Report Sent" onClose={onClose} buttons={<button type="button" className="btn b" onClick={onClose}>Okay</button>}>
        <p style={{ lineHeight: '16px' }}>Thanks for letting us know. A Kithwall moderator will review this {noun}.
          If you&rsquo;re in danger, contact your local emergency services now.</p>
        <p className="gray" style={{ marginTop: 8 }}>You can also block this person from your <Link href="/settings/privacy#blocking">Privacy Settings</Link>.</p>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Report This ${noun[0]!.toUpperCase()}${noun.slice(1)}`} onClose={onClose} buttons={<>
      <button type="button" className="btn b" disabled={busy} onClick={() => void submit()}>{busy ? 'Sending…' : 'Submit'}</button>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
    </>}>
      {err && <div className="err" role="alert">{err}</div>}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 'bold', marginBottom: 6 }}>Why are you reporting this {noun}?</legend>
        {REPORT_REASONS.map(([value, label]) => (
          <label key={value} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} /> {label}
          </label>
        ))}
      </fieldset>
      <label htmlFor="rep-details" style={{ display: 'block', fontWeight: 'bold', margin: '8px 0 3px' }}>Anything else we should know? (optional)</label>
      <textarea id="rep-details" value={details} maxLength={2000} onChange={(e) => setDetails(e.target.value)} style={{ width: '100%', height: 54 }} />
      <div className="kw-warn" style={{ marginTop: 8, marginBottom: 0 }}>
        <b>What happens when you report</b>
        {sharesContent
          ? <>Kithwall can&rsquo;t read encrypted posts, so your device will send moderators <b>a copy of this {noun} and the key that unlocks it</b>.
            They can check that the copy matches what&rsquo;s stored, so reports can&rsquo;t be faked. Nothing else is shared{kind === 'post' || kind === 'photo' ? <> (that key also opens this {noun}&rsquo;s comments)</> : null}.</>
          : <>Moderators will see who you reported and the reason you give. Nothing else you can see is shared.</>}
        {' '}The person you report isn&rsquo;t told who reported them.
      </div>
    </Dialog>
  );
}
